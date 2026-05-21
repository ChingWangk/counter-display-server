"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/** GET /api/praise-script — 经营话术
 *
 * 查询参数（至少传一个）：
 *  - scene=怀旧专区  → 按场景过滤,返回该场景下所有 target_type 的话术
 *  - spec_id=110105  → 进一步过滤 target_type=spec
 *  - brand=中华      → 进一步过滤 target_type=brand
 *  - tag=细支        → 进一步过滤 target_type=tag
 *
 * scene 为常用场景级查询(可单独使用);spec_id/brand/tag 用于更细颗粒过滤,
 * 多个一起传时取并集(OR)。
 * 返回所有匹配话术,按 target_type 优先级排序(spec > brand > tag)。
 */
router.get('/', async (req, res) => {
    const specId = req.query.spec_id;
    const brand = req.query.brand;
    const tag = req.query.tag;
    const scene = req.query.scene;
    if (!specId && !brand && !tag && !scene) {
        res.status(400).json({ success: false, error: '至少传 scene / spec_id / brand / tag 之一' });
        return;
    }
    const conditions = [];
    const params = [];
    const orParts = [];
    if (specId) {
        orParts.push('(target_type = ? AND target_value = ?)');
        params.push('spec', specId);
    }
    if (brand) {
        orParts.push('(target_type = ? AND target_value = ?)');
        params.push('brand', brand);
    }
    if (tag) {
        orParts.push('(target_type = ? AND target_value = ?)');
        params.push('tag', tag);
    }
    // orParts 为空(仅传 scene)时跳过此条件,即返回该场景下所有 target_type 的话术
    if (orParts.length > 0) {
        conditions.push(`(${orParts.join(' OR ')})`);
    }
    if (scene) {
        conditions.push('scene = ?');
        params.push(scene);
    }
    try {
        // 优先级排序：spec(1) > brand(2) > tag(3)
        const [rows] = await db_1.default.execute(`SELECT id, scene, target_type, target_value, script_text
         FROM sys_praise_scripts
        WHERE ${conditions.join(' AND ')}
        ORDER BY FIELD(target_type, 'spec', 'brand', 'tag'), id`, params);
        res.json({ success: true, scripts: rows });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            res.json({ success: true, scripts: [] });
            return;
        }
        console.error('Query praise-script error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
