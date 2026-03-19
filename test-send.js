require("dotenv").config();
const { sendEmail } = require("./services/emailService");

async function run() {
  const resp = await sendEmail({
    to: "devanshd78@gmail.com",
    from: "ime@mail.collabglam.cloud",
    subject: "SES sandbox test",
    text: "Hello from CollabGlam SES test",
    html: "<p>Hello from <b>CollabGlam</b> SES test</p>",
    replyTo: ["reply+t_testthread@mail.collabglam.cloud"],
    configurationSetName: process.env.SES_CONFIGURATION_SET,
    emailTags: [
      { Name: "threadId", Value: "testthread" },
      { Name: "source", Value: "MANUAL_TEST" },
    ],
  });

  console.log("SEND RESPONSE:", resp);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});