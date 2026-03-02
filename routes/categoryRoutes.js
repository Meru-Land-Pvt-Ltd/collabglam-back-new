// routes/category.routes.js
const express = require('express');
const router = express.Router();
const categoryCtrl = require('../controllers/categoryController');

// All categories + their subcategories
router.get('/categories', categoryCtrl.getAllCategoriesWithSubcategories);

// Only subcategories for a selected category (by numeric id)
router.post('/subcategories', categoryCtrl.postSubcategoriesByCategoryId);
router.post('/get', categoryCtrl.postCategoryById);

module.exports = router;
