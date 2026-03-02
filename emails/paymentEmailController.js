// emails/paymentEmailController.js
require("dotenv").config();
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const seller = require("../invoice/seller");

// ✅ transporter (same as you had)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const INVOICE_LOGO_PATH =
  process.env.INVOICE_LOGO_PATH || path.join(process.cwd(), "assets", "logo.png");

const INVOICE_DIR = process.env.INVOICE_DIR || path.join(process.cwd(), "invoices");

// ---------- helpers ----------
function safeText(v) {
  return String(v ?? "").trim();
}

function formatDateUS(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric" }).format(dt);
}

function moneyUSD(cents) {
  const val = (Number(cents || 0) / 100) || 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(val);
}

function joinAddress(addr = {}) {
  const parts = [];
  if (addr.line1) parts.push(addr.line1);
  if (addr.line2) parts.push(addr.line2);
  const cityLine = [addr.city, addr.state, addr.postal_code].filter(Boolean).join(", ");
  if (cityLine) parts.push(cityLine);
  if (addr.country) parts.push(addr.country);
  return parts.join("\n");
}

async function ensureInvoiceDir() {
  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });
}

function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

async function getUserByRoleAndId(role, userId) {
  const r = String(role);
  if (r === "Brand") return Brand.findOne({ brandId: userId });
  if (r === "Influencer") return Influencer.findOne({ influencerId: userId });
  return null;
}

function pickDisplayName(user, role, userId) {
  return (
    user?.name ||
    user?.fullName ||
    user?.brandName ||
    user?.companyName ||
    user?.influencerName ||
    user?.username ||
    `${role} (${userId})`
  );
}

function drawLine(doc, y, color = "#E6E6E6") {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.save();
  doc.strokeColor(color).lineWidth(1);
  doc.moveTo(left, y).lineTo(right, y).stroke();
  doc.restore();
}

function drawHeader(doc, { invoiceNumber, issueDate, paymentStatus, paymentDate }) {
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;

  doc.save();
  doc.rect(0, 0, pageW, 130).fill("#F7F7FB");
  doc.restore();

  doc.save();
  doc.rect(0, 128, pageW, 2).fill("#F4C542");
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(26).fillColor("#111");
  doc.text("INVOICE", left, 45);

  const metaWidth = 270;
  const logoBox = 64;
  const gap = 14;
  const metaX = pageW - right - logoBox - gap - metaWidth;

  const lines = [
    `Invoice Number: ${invoiceNumber}`,
    `Invoice Issue Date: ${issueDate}`,
    `Payment Status: ${paymentStatus}`,
    ...(paymentStatus === "Paid" && paymentDate ? [`Payment Date: ${paymentDate}`] : []),
    "Currency: USD",
  ];

  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(lines.join("\n"), metaX, 44, { width: metaWidth, align: "right" });

  const logoX = pageW - right - logoBox;
  const logoY = 34;

  doc.save();
  doc.roundedRect(logoX - 6, logoY - 6, logoBox + 12, logoBox + 12, 10)
    .fill("#FFFFFF")
    .strokeColor("#E6E6E6")
    .stroke();
  doc.restore();

  try {
    if (fs.existsSync(INVOICE_LOGO_PATH)) {
      doc.image(INVOICE_LOGO_PATH, logoX, logoY, {
        fit: [logoBox, logoBox],
        align: "center",
        valign: "center",
      });
    } else {
      doc.font("Helvetica-Bold").fontSize(16).fillColor("#111");
      doc.text("CG", logoX, logoY + 20, { width: logoBox, align: "center" });
    }
  } catch {}

  doc.y = 150;
}

function invoicePdfDocumentV2({
  invoiceNumber,
  issueDate,
  paymentStatus,
  paymentDate,
  customer,
  lineItem,
  totals,
}) {
  const doc = new PDFDocument({ margin: 50, size: "A4" });

  drawHeader(doc, { invoiceNumber, issueDate, paymentStatus, paymentDate });

  const left = doc.page.margins.left;
  const rightX = doc.page.width - doc.page.margins.right;

  // Seller / Bill To cards
  const cardY = doc.y;
  const cardH = 128;
  const cardW = 245;
  const gap = 15;

  doc.save();
  doc.roundedRect(left, cardY, cardW, cardH, 10).fill("#FFFFFF").strokeColor("#E6E6E6").stroke();
  doc.roundedRect(left + cardW + gap, cardY, cardW, cardH, 10).fill("#FFFFFF").strokeColor("#E6E6E6").stroke();
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Seller", left + 14, cardY + 12);
  doc.text("Bill To", left + cardW + gap + 14, cardY + 12);

  doc.font("Helvetica").fontSize(9.5).fillColor("#333");

  const sellerBlock = [
    seller.legalName,
    ...seller.addressLines,
    `Website: ${seller.website}`,
    `Support Email: ${seller.supportEmail}`,
    `Support Phone: ${seller.supportPhone}`,
    `EIN: ${seller.ein}`,
  ].join("\n");

  doc.text(sellerBlock, left + 14, cardY + 30, { width: cardW - 28 });

  const customerLines = [
    safeText(customer?.legalName || "Customer"),
    joinAddress(customer?.billingAddress || {}),
    ...(safeText(customer?.taxId) ? [`Tax ID / VAT ID: ${safeText(customer.taxId)}`] : []),
    ...(safeText(customer?.email) ? [`Email: ${safeText(customer.email)}`] : []),
  ].filter(Boolean);

  doc.text(customerLines.join("\n"), left + cardW + gap + 14, cardY + 30, { width: cardW - 28 });

  doc.y = cardY + cardH + 18;

  // Table columns
  const descX = left + 10;
  const descW = 280;
  const qtyW = 45;
  const unitW = 95;
  const amountW = 95;
  const rightPad = 10;
  const colGap2 = 18;

  const amountX = rightX - rightPad - amountW;
  const unitX = amountX - colGap2 - unitW;
  const qtyX = unitX - 18 - qtyW;

  // Table header
  const tableTopY = doc.y;
  doc.save();
  doc.roundedRect(left, tableTopY, rightX - left, 26, 8).fill("#F3F4F6");
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111");
  doc.text("Description", descX, tableTopY + 7, { width: descW });
  doc.text("Qty", qtyX, tableTopY + 7, { width: qtyW, align: "right" });
  doc.text("Unit price", unitX, tableTopY + 7, { width: unitW, align: "right" });
  doc.text("Amount", amountX, tableTopY + 7, { width: amountW, align: "right" });

  doc.y = tableTopY + 36;
  drawLine(doc, doc.y);
  doc.moveDown(0.6);

  // Single line item
  const rowStartY = doc.y;

  const main = safeText(lineItem?.name || "Service");
  const sp = safeText(lineItem?.servicePeriodText || "");

  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111");
  doc.text(main, descX, rowStartY, { width: descW });

  let descHeight = doc.heightOfString(main, { width: descW });

  if (sp) {
    doc.font("Helvetica").fontSize(9).fillColor("#666");
    doc.text(`Service Period: ${sp}`, descX, rowStartY + descHeight + 2, { width: descW });
    descHeight += doc.heightOfString(`Service Period: ${sp}`, { width: descW }) + 2;
  }

  doc.font("Helvetica").fontSize(10).fillColor("#111");
  doc.text(String(lineItem?.qty ?? 1), qtyX, rowStartY, { width: qtyW, align: "right" });
  doc.text(moneyUSD(lineItem?.unitPriceCents), unitX, rowStartY, { width: unitW, align: "right" });
  doc.text(moneyUSD(lineItem?.amountCents), amountX, rowStartY, { width: amountW, align: "right" });

  doc.y = rowStartY + Math.max(descHeight, 18) + 12;
  drawLine(doc, doc.y, "#EFEFEF");
  doc.moveDown(1);

  // Totals box
  const totalsY = doc.y + 6;
  const boxW = 250;
  const boxX = rightX - boxW;

  doc.save();
  doc.roundedRect(boxX, totalsY, boxW, 110, 10).fill("#FFFFFF").strokeColor("#E6E6E6").stroke();
  doc.restore();

  const subtotalCents = Number(totals?.subtotalCents || 0);
  const discountCents = Number(totals?.discountCents || 0);
  const taxCents = Number(totals?.taxCents || 0);
  const totalCents = Number(totals?.totalCents || 0);

  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", boxX + 14, totalsY + 14);
  doc.text(moneyUSD(subtotalCents), boxX, totalsY + 14, { width: boxW - 14, align: "right" });

  if (discountCents > 0) {
    doc.text("Discount", boxX + 14, totalsY + 34);
    doc.text(`-${moneyUSD(discountCents)}`, boxX, totalsY + 34, { width: boxW - 14, align: "right" });
  }

  // ✅ MUST APPEAR ALWAYS
  doc.text("Sales Tax / VAT", boxX + 14, totalsY + 54);
  doc.text(moneyUSD(taxCents), boxX, totalsY + 54, { width: boxW - 14, align: "right" });

  doc.font("Helvetica-Bold").fillColor("#111");
  doc.text("Total", boxX + 14, totalsY + 78);
  doc.text(moneyUSD(totalCents), boxX, totalsY + 78, { width: boxW - 14, align: "right" });

  doc.y = totalsY + 130;

  // ✅ Footer terms (EXACT)
  doc.font("Helvetica").fontSize(9).fillColor("#333");
  doc.text("Subscription fees are billed in advance for the service period shown.");
  doc.text("For support: help@collabglam.com");
  doc.text("W-9 available on request (US customers).");

  doc.fillColor("#000000");
  return doc;
}

async function generateInvoicePdfFileV2(data) {
  await ensureInvoiceDir();
  const filename = `${data.invoiceNumber}.pdf`;
  const filePath = path.join(INVOICE_DIR, filename);
  const doc = invoicePdfDocumentV2(data);
  const buffer = await pdfToBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return { filename, filePath, buffer };
}

function buildSuccessEmailHtml({ name, kind, invoiceNumber, totalCents, paidAt }) {
  return `
  <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
    <h2 style="margin: 0 0 12px 0;">Payment Successful ✅</h2>
    <p>Hi ${safeText(name)},</p>
    <p>Your ${kind === "milestone" ? "milestone payment" : "subscription payment"} was successful. Your invoice PDF is attached.</p>
    <div style="background:#f6f6f6; padding: 12px 14px; border-radius: 10px;">
      <ul style="margin:0; padding-left: 18px;">
        <li><b>Invoice:</b> ${safeText(invoiceNumber)}</li>
        <li><b>Amount:</b> ${moneyUSD(totalCents)}</li>
        <li><b>Paid at:</b> ${new Date(paidAt).toLocaleString()}</li>
      </ul>
    </div>
    <p style="margin-top: 18px;">Thanks,<br/><b>CollabGlam Billing</b></p>
  </div>
  `;
}

/**
 * ✅ Send payment success email + attach invoice (new payload)
 */
exports.sendPaymentSuccessEmailWithInvoice = async ({
  kind,
  role,
  userId,
  toEmail,
  toName,
  invoice, // required for best output
  paidAt,
}) => {
  let recipientEmail = safeText(toEmail);
  let recipientName = safeText(toName);

  if (!recipientEmail) {
    const user = await getUserByRoleAndId(role, userId);
    if (!user?.email) throw new Error("Recipient user email not found");
    recipientEmail = user.email;
    recipientName = pickDisplayName(user, role, userId);
  }

  const pdfData = {
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    paymentStatus: invoice.paymentStatus,
    paymentDate: invoice.paymentDate,
    customer: invoice.customer,
    lineItem: invoice.lineItem,
    totals: invoice.totals,
  };

  const pdfResult = await generateInvoicePdfFileV2(pdfData);

  const subject =
    kind === "milestone"
      ? `CollabGlam Invoice ${pdfData.invoiceNumber} (Milestone Payment)`
      : `CollabGlam Invoice ${pdfData.invoiceNumber} (Subscription Payment)`;

  const html = buildSuccessEmailHtml({
    name: recipientName,
    kind,
    invoiceNumber: pdfData.invoiceNumber,
    totalCents: pdfData.totals.totalCents,
    paidAt: paidAt || new Date(),
  });

  const mail = await transporter.sendMail({
    from: `CollabGlam LLC <help@collabglam.com>`,
    to: recipientEmail,
    subject,
    html,
    attachments: [{ filename: pdfResult.filename, content: pdfResult.buffer, contentType: "application/pdf" }],
  });

  return {
    ok: true,
    messageId: mail.messageId,
    invoiceNumber: pdfData.invoiceNumber,
    invoiceFilePath: pdfResult.filePath,
    invoiceFilename: pdfResult.filename,
    recipientEmail,
  };
};

// ✅ Preview API buffer generator
exports.generateInvoicePdfBuffer = async (data) => {
  const doc = invoicePdfDocumentV2(data);
  const buffer = await pdfToBuffer(doc);
  return { buffer, filename: `${data.invoiceNumber}.pdf` };
};