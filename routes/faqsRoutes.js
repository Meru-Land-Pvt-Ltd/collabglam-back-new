const express = require('express');
const router = express.Router();
const faqCtrl = require('../controllers/faqsController');

router.post('/create',    faqCtrl.createFAQ);
router.post('/get',        faqCtrl.getAllFAQs);
router.post('/getById',   faqCtrl.getFAQById);
router.post('/updateById',faqCtrl.updateFAQ);
router.post('/deleteById',faqCtrl.deleteFAQ);

module.exports = router;
