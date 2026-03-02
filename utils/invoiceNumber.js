// utils/invoiceNumber.js
const InvoiceCounter = require("../models/invoiceCounter");

async function nextInvoiceNumber(now = new Date()) {
  const year = now.getFullYear();

  const doc = await InvoiceCounter.findOneAndUpdate(
    { year },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const seq = String(doc.seq).padStart(6, "0");
  return `CG-${year}-${seq}`;
}

module.exports = { nextInvoiceNumber };