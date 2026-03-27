'use strict';

const express = require('express');
const router = express.Router();

const controller = require('../controllers/brandNetworkController');

const { adminAuth } = require('../middlewares/adminAuth');

router.post('/create', adminAuth, controller.createBrandNetworkRow);
router.get('/list', adminAuth, controller.listBrandNetwork);
router.get('/:id', adminAuth, controller.getBrandNetworkById);
router.post('/update', adminAuth, controller.updateBrandNetwork);

module.exports = router;