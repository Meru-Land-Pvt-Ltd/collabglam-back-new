require("dotenv").config();

const Contact = require("../models/contactUs");
const NewsLetter = require("../models/newsletter");
const { Parser } = require("json2csv");
const ExcelJS = require("exceljs");
const nodemailer = require("nodemailer");

exports.sendContact = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      logger: true,
      debug: true,
      tls: {
        rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false",
      },
    });

    await transporter.verify();

    // Use verified FROM (prevents DMARC / spoofing issues)
    const fromAddress = process.env.MAIL_FROM || process.env.SMTP_USER;

    await transporter.sendMail({
      from: `CollabGlam <${fromAddress}>`,
      to: process.env.MAIL_TO,
      replyTo: email,
      subject: `Contact Us: ${subject}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    });

    const saved = await new Contact({ name, email, subject, message }).save();

    return res.status(201).json({
      message: "Message sent and saved successfully",
      contact: saved,
    });
  } catch (err) {
    console.error("ContactController Error:", err);
    return res.status(500).json({ error: "Could not send message, please try again later" });
  }
};

exports.getAllContacts = async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ createdAt: -1 });
    return res.status(200).json(contacts);
  } catch (err) {
    console.error("getAllContacts error", err);
    return res.status(500).json({ error: "Server error" });
  }
};

exports.createNewsletter = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const exists = await NewsLetter.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email already subscribed" });

    const subscriber = await new NewsLetter({ email }).save();
    return res.status(201).json({ message: "Subscribed successfully", subscriber });
  } catch (err) {
    console.error("createNewsletter error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

exports.getNewsletterList = async (req, res) => {
  try {
    const list = await NewsLetter.find().sort({ createdAt: -1 }).select("email createdAt");
    return res.status(200).json({ subscribers: list });
  } catch (err) {
    console.error("getNewsletterList error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

exports.downloadNewsletter = async (req, res) => {
  try {
    const { type } = req.body;
    if (!type || !["csv", "excel"].includes(type)) {
      return res.status(400).json({ error: 'Invalid or missing type; must be "csv" or "excel"' });
    }

    const list = await NewsLetter.find()
      .sort({ createdAt: -1 })
      .select("email createdAt -_id")
      .lean();

    if (type === "csv") {
      const fields = ["email", "createdAt"];
      const parser = new Parser({ fields, quote: '"' });
      const csv = parser.parse(list);

      res.header("Content-Type", "text/csv");
      res.attachment("newsletter_emails.csv");
      return res.send(csv);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Subscribers");

    ws.columns = [
      { header: "Email", key: "email", width: 30 },
      { header: "Subscribed At", key: "createdAt", width: 25 },
    ];

    list.forEach((item) => {
      ws.addRow({
        email: item.email,
        createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : "",
      });
    });

    const buf = await wb.xlsx.writeBuffer();

    res.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.attachment("newsletter_emails.xlsx");
    return res.send(buf);
  } catch (err) {
    console.error("downloadNewsletter error:", err);
    return res.status(500).json({ error: "Could not generate download" });
  }
};
