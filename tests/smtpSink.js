const net = require('net');

/**
 * A minimal SMTP server that accepts mail and keeps it in memory.
 *
 * The suite needs to read the activation link out of an onboarding email, and
 * the application now has exactly one mail transport: real SMTP. Rather than
 * give the application a second, fake transport that exists only for tests -
 * and that could be switched on in production by accident - the test brings
 * its own relay and the application talks to it exactly as it would to any
 * other.
 *
 * It implements only what nodemailer needs to complete a session: the greeting,
 * EHLO, AUTH, the envelope, DATA, and QUIT. No TLS, no real delivery, no
 * validation of anything. It is a capture buffer that speaks enough SMTP to be
 * talked to, and it is only ever bound to the loopback interface.
 */
function startSmtpSink({ port = 2525, host = '127.0.0.1' } = {}) {
  const messages = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let dataLines = [];
    // Set by AUTH LOGIN, which sends the username and password as two separate
    // base64 lines after the command.
    let expecting = null;

    const say = (line) => socket.write(line + '\r\n');
    say('220 smtp-sink ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(parseMessage(dataLines.join('\n')));
            dataLines = [];
            say('250 2.0.0 Ok: queued');
          } else {
            // A leading dot on a body line is doubled by the sender.
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }

        if (expecting) {
          expecting = expecting === 'username' ? 'password' : null;
          say(expecting ? '334 UGFzc3dvcmQ6' : '235 2.7.0 Authentication successful');
          continue;
        }

        const command = line.split(' ')[0].toUpperCase();
        switch (command) {
          case 'EHLO':
            // No STARTTLS advertised, so nodemailer will not try to upgrade.
            socket.write('250-smtp-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
            break;
          case 'HELO':
            say('250 smtp-sink');
            break;
          case 'AUTH':
            if (/^AUTH\s+LOGIN\s*$/i.test(line)) {
              expecting = 'username';
              say('334 VXNlcm5hbWU6');
            } else {
              say('235 2.7.0 Authentication successful');
            }
            break;
          case 'MAIL':
          case 'RCPT':
          case 'RSET':
          case 'NOOP':
            say('250 2.1.0 Ok');
            break;
          case 'DATA':
            inData = true;
            say('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'QUIT':
            say('221 2.0.0 Bye');
            socket.end();
            break;
          default:
            say('250 2.0.0 Ok');
        }
      }
    });

    socket.on('error', () => { /* a client hanging up is not a test failure */ });
  });

  /** Headers as a lowercased map, with continuation lines unfolded. */
  function parseHeaders(headerText) {
    const headers = {};
    for (const line of headerText.replace(/\n[ \t]+/g, ' ').split('\n')) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return headers;
  }

  /**
   * Undoes the transfer encoding a part was sent in.
   *
   * This is not optional decoration. Quoted-printable breaks any line over 76
   * characters with a trailing `=`, and an activation URL carrying a 64-character
   * token is always over that - so reading the raw payload yields a token cut in
   * half, which the application then correctly rejects as invalid. The bug would
   * look exactly like a broken activation flow.
   */
  function decodePart(body, encoding) {
    const how = String(encoding || '').toLowerCase();
    if (how === 'base64') {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (how === 'quoted-printable') {
      return body
        .replace(/=\r?\n/g, '')                                   // soft line breaks
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return body;
  }

  /**
   * Splits the raw DATA payload into headers plus fully decoded text.
   *
   * A message with both a plain and an HTML alternative arrives as multipart;
   * every part is decoded and concatenated, so an assertion can look for a
   * string without caring which alternative carried it.
   */
  function parseMessage(raw) {
    const split = raw.indexOf('\n\n');
    const headerText = split === -1 ? raw : raw.slice(0, split);
    const body = split === -1 ? '' : raw.slice(split + 2);
    const headers = parseHeaders(headerText);

    const boundaryMatch = /boundary="?([^";\s]+)"?/i.exec(headers['content-type'] || '');
    let text;

    if (boundaryMatch) {
      const marker = '--' + boundaryMatch[1];
      text = body
        .split(marker)
        .slice(1, -1) // drop the preamble and the closing epilogue
        .map((part) => {
          const at = part.indexOf('\n\n');
          if (at === -1) return part;
          const partHeaders = parseHeaders(part.slice(0, at));
          return decodePart(part.slice(at + 2), partHeaders['content-transfer-encoding']);
        })
        .join('\n');
    } else {
      text = decodePart(body, headers['content-transfer-encoding']);
    }

    return { headers, body, text, raw };
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port,
        host,
        messages,
        /** The most recent message addressed to `address`, or null. */
        lastTo(address) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if ((messages[i].headers.to || '').includes(address)) return messages[i];
          }
          return null;
        },
        clear() { messages.length = 0; },
        stop() { return new Promise((done) => server.close(done)); },
      });
    });
  });
}

module.exports = { startSmtpSink };
