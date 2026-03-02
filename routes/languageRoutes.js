const router = require('express').Router();
const ctrl = require('../controllers/languageController');


router.get('/all', ctrl.getAll);
router.get('/list', ctrl.getList);


module.exports = router;