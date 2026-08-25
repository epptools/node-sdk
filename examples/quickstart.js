'use strict';

// Minimal end-to-end example. Requires a live endpoint + credentials.
//   node examples/quickstart.js

const { Client, Config, CommandError, EppError } = require('..');

async function main() {
  const client = new Client(
    new Config({
      host: 'epp.registry.example',
      clid: 'EXAMPLE',
      password: 'your-secret',
      port: 700,          // default; override only if the endpoint moves
      lang: 'uk',         // localized result messages: en | uk | ua | ru
      readTimeout: 30000, // MILLISECONDS (minimum 1000)
      // Port 700 presents a certificate from the registry's OWN private CA, so the CA bundle is
      // REQUIRED — without it the handshake fails verification.
      caFile: process.env.EPP_CA || '/path/to/registry-ca.pem',
    }),
    null,
    console, // optional logger (passwords/authInfo are masked)
  );

  try {
    await client.connect();   // TLS + read <greeting>
    await client.login();

    const avail = (await client.domain.check(['example.com.ua'])).availability();
    console.log('availability:', avail);

    const info = await client.domain.info('example.com.ua');
    console.log('exDate:', info.value('exDate'));

    const bal = (await client.balance()).balance();
    console.log('balance:', bal);

    const msg = await client.poll.request();
    if (msg.messageId() !== null) {
      // queueMessage() is the NOTICE text. message() is the result banner ("ack to dequeue"),
      // identical on every poll reply — printing it and then acking destroys the unread notice
      // at the registry for good.
      console.log('poll:', msg.queueDate(), msg.queueMessage());
      await client.poll.ack(msg.messageId());
    }

    await client.logout();
  } catch (err) {
    if (err instanceof CommandError) console.error(`EPP error ${err.eppCode}: ${err.message}`);
    else if (err instanceof EppError) console.error('SDK error:', err.message);
    else throw err;
  } finally {
    client.disconnect();
  }
}

main();



