'use strict';

const express = require('express');
const router = express.Router();

const controller = require('../controllers/pitchFolderController');
const { adminAuth } = require('../middlewares/adminAuth');

// public shared routes
router.get('/shared/:token', controller.getSharedFolder);
router.post('/shared/:token/good-fit/:itemId', controller.updateSharedFolderGoodFit);

// admin routes
router.get('/list', adminAuth, controller.listFolders);
router.post('/create', adminAuth, controller.createFolder);
router.get('/:id', adminAuth, controller.getFolderById);
router.post('/update', adminAuth, controller.updateFolder);
router.post('/archive', adminAuth, controller.archiveFolder);

router.post('/:id/item', adminAuth, controller.addFolderItem);
router.post('/item/update', adminAuth, controller.updateFolderItem);
router.post('/item/delete', adminAuth, controller.deleteFolderItem);

router.post('/:id/share-link', adminAuth, controller.generateShareLink);
router.post('/:id/import-youtube', adminAuth, controller.bulkImportYoutubeToFolder);

module.exports = router;