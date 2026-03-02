const Language = require('../models/language');


// GET /api/languages/all
// Return all languages (sorted by name)
exports.getAll = async (req, res, next) => {
    try {
        const data = await Language.find({}).sort({ name: 1 }).lean();
        res.json({ total: data.length, data });
    } catch (err) {
        next(err);
    }
};


// GET /api/languages/list?search=&page=&limit=&sortBy=&order=
// Paginated & searchable list
exports.getList = async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page ?? '1', 10), 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit ?? '20', 10), 1), 200);
        const search = (req.query.search ?? '').trim();
        const sortBy = (req.query.sortBy ?? 'name').trim();
        const order = (req.query.order ?? 'asc').toLowerCase() === 'desc' ? -1 : 1;


        const filter = {};
        if (search) {
            const rx = new RegExp(search, 'i');
            filter.$or = [{ name: rx }, { code: rx }];
        }


        const [data, total] = await Promise.all([
            Language.find(filter)
                .sort({ [sortBy]: order })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Language.countDocuments(filter)
        ]);


        res.json({
            total,
            page,
            pages: Math.ceil(total / limit) || 1,
            limit,
            data
        });
    } catch (err) {
        next(err);
    }
};