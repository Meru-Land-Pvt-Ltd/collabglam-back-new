require('dotenv').config();
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const ses = new SESClient({
  region: process.env.AWS_REGION,
});

async function main() {
  const params = {
    Source: `Test <jageryjhfvgaish@collabglam.cloud>`, // must be from your verified domain
    Destination: {
      ToAddresses: ['priyanshuyad2001@gmail.com'],
    },
    Message: {
      Subject: { Data: 'SES test from Node', Charset: 'UTF-8' },
      Body: {
        Text: { Data: 'Hello from SES + Node.js', Charset: 'UTF-8' },
      },
    },
  };

  try {
    const res = await ses.send(new SendEmailCommand(params));
    console.log('Email sent OK:', res.MessageId);
  } catch (err) {
    console.error('Error sending email:', err);
  }
}

main();
