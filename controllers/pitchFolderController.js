'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const PitchFolder = require('../models/pitchFolder');
const { AdminModel, ROLES } = require('../models/master');

function cleanStr(v) {
    if (v === undefined || v === null) return '';
    return String(v).trim();
}

function uniqStrings(values = []) {
    const out = [];
    const seen = new Set();

    for (const value of values) {
        const s = cleanStr(value);
        if (!s) continue;

        const key = s.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        out.push(s);
    }

    return out;
}

function toNullableNumber(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function slugify(value) {
    return cleanStr(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function getActorAdminId(actor) {
    return actor?.adminId || actor?._id || actor?.id || null;
}

function toDesignation(role) {
    const raw = cleanStr(role).toLowerCase();
    if (!raw) return '';
    return raw
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function isSuperAdmin(actor) {
    return cleanStr(actor?.role).toLowerCase() === ROLES.SUPER_ADMIN;
}

function isRevenueHead(actor) {
    return cleanStr(actor?.role).toLowerCase() === ROLES.REVENUE_HEAD;
}

function isIme(actor) {
    return cleanStr(actor?.role).toLowerCase() === ROLES.IME;
}

function canCreateOrManagePitchFolders(actor) {
    if (!actor) return false;
    return isSuperAdmin(actor) || isRevenueHead(actor) || isIme(actor);
}

function normalizeItem(body = {}, actorId = null) {
    const links = Array.isArray(body.links)
        ? uniqStrings(body.links)
        : uniqStrings(String(body.links || '').split(','));

    const primaryLink =
        cleanStr(body.primaryLink) || (links.length ? links[0] : '');

    const niche = Array.isArray(body.niche)
        ? uniqStrings(body.niche)
        : uniqStrings(String(body.niche || '').split(','));

    return {
        provider: cleanStr(body.provider || 'other').toLowerCase() || 'other',
        name: cleanStr(body.name),
        username: cleanStr(body.username),
        handle: cleanStr(body.handle),
        followers: toNullableNumber(body.followers),
        primaryLink,
        links,
        niche,
        email: cleanStr(body.email).toLowerCase(),
        country: cleanStr(body.country),
        additionalInfo: cleanStr(body.additionalInfo),
        selectionReason: cleanStr(body.selectionReason),
        goodFit: !!body.goodFit,
        rateUsd: toNullableNumber(body.rateUsd),
        ourFeePct: toNullableNumber(body.ourFeePct),
        comments: cleanStr(body.comments),
        sourcePipelineId:
            body.sourcePipelineId &&
                mongoose.Types.ObjectId.isValid(String(body.sourcePipelineId))
                ? new mongoose.Types.ObjectId(String(body.sourcePipelineId))
                : null,
        updatedByAdmin: actorId || null,
    };
}

function getShareBaseUrl() {
    return (
        process.env.PITCH_FOLDER_SHARE_BASE_URL ||
        'https://collabglam.com/pitch-folder/shared'
    );
}

function buildCreatorPopulate() {
    return {
        path: 'createdByAdmin',
        select:
            'name email proxyEmail role teamType status parentAdmin rootAdmin createdBy',
        populate: [
            {
                path: 'parentAdmin',
                select: 'name email role teamType',
            },
            {
                path: 'rootAdmin',
                select: 'name email role teamType',
            },
            {
                path: 'createdBy',
                select: 'name email role teamType',
            },
        ],
    };
}

function buildUpdatedByPopulate() {
    return {
        path: 'updatedByAdmin',
        select:
            'name email proxyEmail role teamType status parentAdmin rootAdmin createdBy',
        populate: [
            {
                path: 'parentAdmin',
                select: 'name email role teamType',
            },
            {
                path: 'rootAdmin',
                select: 'name email role teamType',
            },
            {
                path: 'createdBy',
                select: 'name email role teamType',
            },
        ],
    };
}

function buildSharedByPopulate() {
    return {
        path: 'share.sharedByAdminId',
        select: 'name email role teamType',
    };
}

function serializeMiniAdmin(admin) {
    if (!admin) return null;

    return {
        _id: String(admin._id),
        adminId: String(admin._id),
        name: admin.name || '',
        email: admin.email || '',
        role: cleanStr(admin.role).toLowerCase(),
        designation: toDesignation(admin.role),
        teamType: admin.teamType || null,
    };
}

function serializeAdmin(admin) {
    if (!admin) return null;

    return {
        _id: String(admin._id),
        adminId: String(admin._id),
        name: admin.name || '',
        email: admin.email || '',
        proxyEmail: admin.proxyEmail || '',
        role: cleanStr(admin.role).toLowerCase(),
        designation: toDesignation(admin.role),
        teamType: admin.teamType || null,
        status: cleanStr(admin.status).toLowerCase(),
        parentAdmin: serializeMiniAdmin(admin.parentAdmin),
        rootAdmin: serializeMiniAdmin(admin.rootAdmin),
        createdBy: serializeMiniAdmin(admin.createdBy),
    };
}

function applyFolderSearch(filter, q) {
    if (!q) return filter;

    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    return {
        ...filter,
        $or: [
            { title: rx },
            { description: rx },
            { slug: rx },
            { 'items.name': rx },
            { 'items.username': rx },
            { 'items.handle': rx },
            { 'items.email': rx },
        ],
    };
}

async function getAccessibleCreatorIds(actor) {
    if (!canCreateOrManagePitchFolders(actor)) return [];

    const actorId = getActorAdminId(actor);
    if (!actorId || !mongoose.Types.ObjectId.isValid(String(actorId))) return [];

    const actorObjectId = new mongoose.Types.ObjectId(String(actorId));

    if (isSuperAdmin(actor)) {
        const allEligibleAdmins = await AdminModel.find({
            role: { $in: [ROLES.SUPER_ADMIN, ROLES.REVENUE_HEAD, ROLES.IME] },
            status: 'active',
        })
            .select('_id')
            .lean();

        return allEligibleAdmins.map((a) => a._id);
    }

    if (isRevenueHead(actor)) {
        const assignedImeAdmins = await AdminModel.find({
            role: ROLES.IME,
            status: 'active',
            parentAdmin: actorObjectId,
        })
            .select('_id')
            .lean();

        return [
            actorObjectId,
            ...assignedImeAdmins.map((a) => a._id),
        ];
    }

    if (isIme(actor)) {
        return [actorObjectId];
    }

    return [];
}

async function buildFolderAccessFilter(actor) {
    if (!canCreateOrManagePitchFolders(actor)) return null;

    if (isSuperAdmin(actor)) {
        return { archivedAt: null };
    }

    const creatorIds = await getAccessibleCreatorIds(actor);

    return {
        archivedAt: null,
        createdByAdmin: { $in: creatorIds },
    };
}

async function findAccessibleFolder(folderId, actor) {
    const scope = await buildFolderAccessFilter(actor);
    if (!scope) return null;

    return PitchFolder.findOne({
        _id: folderId,
        ...scope,
    })
        .populate(buildCreatorPopulate())
        .populate(buildUpdatedByPopulate())
        .populate(buildSharedByPopulate())
        .exec();
}

function serializeFolderListItem(doc) {
    return {
        _id: doc._id,
        title: doc.title,
        slug: doc.slug,
        description: doc.description,
        share: doc.share
            ? {
                token: doc.share.token || '',
                url: doc.share.url || '',
                generatedAt: doc.share.generatedAt || null,
                sharedBy: serializeMiniAdmin(doc.share.sharedByAdminId),
            }
            : {},
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        itemCount: Array.isArray(doc.items) ? doc.items.length : 0,
        createdBy: serializeAdmin(doc.createdByAdmin),
        updatedBy: serializeAdmin(doc.updatedByAdmin),
    };
}

function serializeFolderDetail(doc) {
    return {
        _id: doc._id,
        title: doc.title,
        slug: doc.slug,
        description: doc.description,
        share: doc.share
            ? {
                token: doc.share.token || '',
                url: doc.share.url || '',
                generatedAt: doc.share.generatedAt || null,
                sharedBy: serializeMiniAdmin(doc.share.sharedByAdminId),
            }
            : {},
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        createdBy: serializeAdmin(doc.createdByAdmin),
        updatedBy: serializeAdmin(doc.updatedByAdmin),
        items: doc.items || [],
    };
}

exports.listFolders = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to access pitch folders' });
        }

        const q = cleanStr(req.query.q);
        const baseFilter = await buildFolderAccessFilter(req.admin);

        if (!baseFilter) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to access pitch folders' });
        }

        const filter = applyFolderSearch(baseFilter, q);

        const docs = await PitchFolder.find(filter)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .sort({ updatedAt: -1 })
            .lean();

        return res.json({
            success: true,
            data: docs.map(serializeFolderListItem),
        });
    } catch (err) {
        console.error('[listFolders] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.createFolder = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to create pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const body = req.body || {};

        const title = cleanStr(body.title);
        if (!title) {
            return res.status(400).json({ error: 'title is required' });
        }

        const baseSlug = slugify(title) || `pitch-folder-${Date.now()}`;
        let slug = baseSlug;
        let counter = 1;

        while (await PitchFolder.exists({ slug, archivedAt: null })) {
            counter += 1;
            slug = `${baseSlug}-${counter}`;
        }

        const initialItems = Array.isArray(body.items)
            ? body.items.map((item) => ({
                ...normalizeItem(item, actorId),
                createdByAdmin: actorId || null,
            }))
            : [];

        const doc = await PitchFolder.create({
            title,
            slug,
            description: cleanStr(body.description),
            items: initialItems,
            createdByAdmin: actorId || null,
            updatedByAdmin: actorId || null,
        });

        const hydrated = await PitchFolder.findById(doc._id)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .lean();

        return res.json({
            success: true,
            message: 'Pitch folder created successfully',
            data: serializeFolderDetail(hydrated),
        });
    } catch (err) {
        console.error('[createFolder] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.getFolderById = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res
        .status(403)
        .json({ error: 'You are not allowed to access pitch folders' });
    }

    const id = cleanStr(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);

    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    return res.json({
      success: true,
      data: serializeFolderDetail(doc),
    });
  } catch (err) {
    console.error('[getFolderById] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolder = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to update pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const id = cleanStr(req.body?.id);
        const title = cleanStr(req.body?.title);
        const description = cleanStr(req.body?.description);

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Valid folder id is required' });
        }

        const accessible = await findAccessibleFolder(id, req.admin);
        if (!accessible) {
            return res.status(404).json({ error: 'Pitch folder not found' });
        }

        if (title) {
            const baseSlug = slugify(title) || `pitch-folder-${Date.now()}`;
            let slug = baseSlug;
            let counter = 1;

            while (
                await PitchFolder.exists({
                    _id: { $ne: accessible._id },
                    slug,
                    archivedAt: null,
                })
            ) {
                counter += 1;
                slug = `${baseSlug}-${counter}`;
            }

            accessible.title = title;
            accessible.slug = slug;
        }

        if (req.body?.description !== undefined) {
            accessible.description = description;
        }

        accessible.updatedByAdmin = actorId || null;
        await accessible.save();

        const hydrated = await PitchFolder.findById(accessible._id)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .lean();

        return res.json({
            success: true,
            message: 'Pitch folder updated successfully',
            data: serializeFolderDetail(hydrated),
        });
    } catch (err) {
        console.error('[updateFolder] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.archiveFolder = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to archive pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const id = cleanStr(req.body?.id);

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Valid folder id is required' });
        }

        const accessible = await findAccessibleFolder(id, req.admin);
        if (!accessible) {
            return res.status(404).json({ error: 'Pitch folder not found' });
        }

        accessible.archivedAt = new Date();
        accessible.updatedByAdmin = actorId || null;
        await accessible.save();

        return res.json({
            success: true,
            message: 'Pitch folder archived successfully',
        });
    } catch (err) {
        console.error('[archiveFolder] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.addFolderItem = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to update pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const folderId = cleanStr(req.params.id);

        if (!mongoose.Types.ObjectId.isValid(folderId)) {
            return res.status(400).json({ error: 'Valid folder id is required' });
        }

        const doc = await findAccessibleFolder(folderId, req.admin);
        if (!doc) {
            return res.status(404).json({ error: 'Pitch folder not found' });
        }

        const item = {
            ...normalizeItem(req.body || {}, actorId),
            createdByAdmin: actorId || null,
        };

        if (!item.name) {
            return res.status(400).json({ error: 'Influencer name is required' });
        }

        doc.items.push(item);
        doc.updatedByAdmin = actorId || null;
        await doc.save();

        const hydrated = await PitchFolder.findById(doc._id)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .lean();

        return res.json({
            success: true,
            message: 'Influencer added successfully',
            data: serializeFolderDetail(hydrated),
        });
    } catch (err) {
        console.error('[addFolderItem] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.updateFolderItem = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to update pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const folderId = cleanStr(req.body?.folderId);
        const itemId = cleanStr(req.body?.itemId);

        if (
            !mongoose.Types.ObjectId.isValid(folderId) ||
            !mongoose.Types.ObjectId.isValid(itemId)
        ) {
            return res
                .status(400)
                .json({ error: 'Valid folderId and itemId are required' });
        }

        const doc = await findAccessibleFolder(folderId, req.admin);
        if (!doc) {
            return res.status(404).json({ error: 'Pitch folder not found' });
        }

        const item = doc.items.id(itemId);
        if (!item) {
            return res.status(404).json({ error: 'Folder item not found' });
        }

        const normalized = normalizeItem(req.body || {}, actorId);
        Object.assign(item, normalized);

        if (!cleanStr(item.name)) {
            return res.status(400).json({ error: 'Influencer name is required' });
        }

        item.updatedByAdmin = actorId || null;
        doc.updatedByAdmin = actorId || null;
        await doc.save();

        const hydrated = await PitchFolder.findById(doc._id)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .lean();

        return res.json({
            success: true,
            message: 'Influencer updated successfully',
            data: serializeFolderDetail(hydrated),
        });
    } catch (err) {
        console.error('[updateFolderItem] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.deleteFolderItem = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to update pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const folderId = cleanStr(req.body?.folderId);
        const itemId = cleanStr(req.body?.itemId);

        if (
            !mongoose.Types.ObjectId.isValid(folderId) ||
            !mongoose.Types.ObjectId.isValid(itemId)
        ) {
            return res
                .status(400)
                .json({ error: 'Valid folderId and itemId are required' });
        }

        const doc = await findAccessibleFolder(folderId, req.admin);
        if (!doc) {
            return res.status(404).json({ error: 'Pitch folder not found' });
        }

        const item = doc.items.id(itemId);
        if (!item) {
            return res.status(404).json({ error: 'Folder item not found' });
        }

        item.deleteOne();
        doc.updatedByAdmin = actorId || null;
        await doc.save();

        const hydrated = await PitchFolder.findById(doc._id)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .lean();

        return res.json({
            success: true,
            message: 'Influencer removed successfully',
            data: serializeFolderDetail(hydrated),
        });
    } catch (err) {
        console.error('[deleteFolderItem] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.generateShareLink = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to share pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const id = cleanStr(req.params.id);

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Valid folder id is required' });
        }

        const doc = await findAccessibleFolder(id, req.admin);
        if (!doc) {
            return res.status(404).json({ error: 'Pitch folder not found' });
        }

        const token = crypto.randomBytes(24).toString('hex');
        const url = `${getShareBaseUrl()}/${token}`;

        doc.share = {
            token,
            url,
            generatedAt: new Date(),
            sharedByAdminId: actorId || null,
        };
        doc.updatedByAdmin = actorId || null;

        await doc.save();

        const hydrated = await PitchFolder.findById(doc._id)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .lean();

        return res.json({
            success: true,
            message: 'Share link generated successfully',
            data: serializeFolderDetail(hydrated).share,
        });
    } catch (err) {
        console.error('[generateShareLink] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.getSharedFolder = async (req, res) => {
    try {
        const token = cleanStr(req.params.token);

        if (!token) {
            return res.status(400).json({ error: 'Share token is required' });
        }

        const doc = await PitchFolder.findOne({
            'share.token': token,
            archivedAt: null,
        }).lean();

        if (!doc) {
            return res.status(404).json({ error: 'Shared pitch folder not found' });
        }

        return res.json({
            success: true,
            data: {
                _id: doc._id,
                title: doc.title,
                description: doc.description,
                share: doc.share,
                items: (doc.items || []).map((item) => ({
                    _id: item._id,
                    provider: item.provider,
                    name: item.name,
                    username: item.username,
                    handle: item.handle,
                    followers: item.followers,
                    primaryLink: item.primaryLink,
                    links: item.links,
                    niche: item.niche,
                    email: item.email,
                    country: item.country,
                    additionalInfo: item.additionalInfo,
                    selectionReason: item.selectionReason,
                    goodFit: item.goodFit,
                    rateUsd: item.rateUsd,
                    ourFeePct: item.ourFeePct,
                    comments: item.comments,
                })),
            },
        });
    } catch (err) {
        console.error('[getSharedFolder] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.bulkImportYoutubeToFolder = async (req, res) => {
    try {
        if (!canCreateOrManagePitchFolders(req.admin)) {
            return res
                .status(403)
                .json({ error: 'You are not allowed to update pitch folders' });
        }

        const actorId = getActorAdminId(req.admin);
        const folderId = cleanStr(req.params.id);
        const rawUsers = Array.isArray(req.body?.rawUsers) ? req.body.rawUsers : [];

        if (!mongoose.Types.ObjectId.isValid(folderId)) {
            return res.status(400).json({ error: 'Valid folder id is required' });
        }

        if (!rawUsers.length) {
            return res.status(400).json({ error: 'rawUsers are required' });
        }

        const folder = await findAccessibleFolder(folderId, req.admin);
        if (!folder) {
            return res.status(404).json({ error: 'Pitch folder not found' });
        }

        const existingKeys = new Set(
            (folder.items || []).map((item) => {
                const provider = cleanStr(item.provider).toLowerCase();
                const username =
                    cleanStr(item.username).toLowerCase() ||
                    cleanStr(item.handle).replace(/^@/, '').toLowerCase();
                return `${provider}:${username}`;
            })
        );

        let added = 0;

        for (const user of rawUsers) {
            const item = {
                provider: cleanStr(user.platform || 'youtube').toLowerCase() || 'youtube',
                name: cleanStr(user.fullname || user.name),
                username: cleanStr(user.username),
                handle: cleanStr(user.handle),
                followers: toNullableNumber(user.followers),
                primaryLink: cleanStr(user.url),
                links: uniqStrings([user.url]),
                niche: Array.isArray(user.categories) ? uniqStrings(user.categories) : [],
                email: cleanStr(user.email).toLowerCase(),
                country: cleanStr(user.country),
                additionalInfo: '',
                selectionReason: '',
                goodFit: false,
                rateUsd: null,
                ourFeePct: null,
                comments: '',
                createdByAdmin: actorId || null,
                updatedByAdmin: actorId || null,
            };

            if (!item.name) continue;

            const dedupeKey = `${item.provider}:${(item.username || item.handle || '')
                .replace(/^@/, '')
                .toLowerCase()}`;

            if (!dedupeKey || existingKeys.has(dedupeKey)) continue;

            folder.items.push(item);
            existingKeys.add(dedupeKey);
            added += 1;
        }

        folder.updatedByAdmin = actorId || null;
        await folder.save();

        const hydrated = await PitchFolder.findById(folder._id)
            .populate(buildCreatorPopulate())
            .populate(buildUpdatedByPopulate())
            .populate(buildSharedByPopulate())
            .lean();

        return res.json({
            success: true,
            message: 'Youtube creators imported successfully',
            added,
            total: hydrated?.items?.length || 0,
            data: serializeFolderDetail(hydrated),
        });
    } catch (err) {
        console.error('[bulkImportYoutubeToFolder] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};

exports.updateSharedFolderGoodFit = async (req, res) => {
    try {
        const token = cleanStr(req.params.token);
        const itemId = cleanStr(req.params.itemId);
        const goodFit = !!req.body?.goodFit;

        if (!token) {
            return res.status(400).json({ error: 'Share token is required' });
        }

        if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
            return res.status(400).json({ error: 'Valid item id is required' });
        }

        const doc = await PitchFolder.findOne({
            'share.token': token,
            archivedAt: null,
        });

        if (!doc) {
            return res.status(404).json({ error: 'Shared pitch folder not found' });
        }

        const item = doc.items.id(itemId);
        if (!item) {
            return res.status(404).json({ error: 'Folder item not found' });
        }

        item.goodFit = goodFit;
        await doc.save();

        return res.json({
            success: true,
            message: 'Good fit updated successfully',
            data: {
                _id: item._id,
                goodFit: item.goodFit,
            },
        });
    } catch (err) {
        console.error('[updateSharedFolderGoodFit] Error:', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
};