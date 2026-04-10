'use strict';

const express = require('express');
const router = express.Router();

const controller = require('../controllers/pitchFolderController');
const { adminAuth } = require('../middlewares/adminAuth');

// public shared routes
router.get('/shared/:token', controller.getSharedFolder);
router.post('/shared/:token/good-fit/:itemId', controller.updateSharedFolderGoodFit);

// generic brand request route
router.post('/shared/:token/media-kit-request/:itemId', controller.requestSharedFolderMediaKit);

// backward-compatible alias
router.post('/shared/:token/media-kit-link-request/:itemId', controller.requestSharedFolderMediaKit);

// admin routes
router.get('/list', adminAuth, controller.listFolders);
router.post('/create', adminAuth, controller.createFolder);
router.get('/:id', adminAuth, controller.getFolderById);
router.post('/update', adminAuth, controller.updateFolder);
router.post('/archive', adminAuth, controller.archiveFolder);

router.post('/:id/item', adminAuth, controller.addFolderItem);
router.post('/item/update', adminAuth, controller.updateFolderItem);
router.post('/item/delete', adminAuth, controller.deleteFolderItem);

router.post('/item/media-kit/presign', adminAuth, controller.getFolderItemMediaKitUploadUrl);
router.post('/item/media-kit/visibility', adminAuth, controller.updateFolderItemMediaKitVisibility);
router.post('/item/media-kit/approval', adminAuth, controller.updateFolderItemMediaKitApproval);

router.post('/item/media-kit-link/visibility', adminAuth, controller.updateFolderItemMediaKitLinkVisibility);
router.post('/item/media-kit-link/approval', adminAuth, controller.updateFolderItemMediaKitLinkApproval);

router.post('/:id/share-link', adminAuth, controller.generateShareLink);
router.post('/:id/import-youtube', adminAuth, controller.bulkImportYoutubeToFolder);

module.exports = router;