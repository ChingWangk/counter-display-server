"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const categoryCatalog_1 = require("../services/categoryCatalog");
const router = (0, express_1.Router)();
/** 根据 Category 推断该规格适用的 tag 集合(用于 sys_praise_scripts target_value)。
 *  支持的 tag:细支 / 中支 / 短支 / 爆珠 / 一类烟 / 二类烟 / 工商共育 / 经典款 / 低焦油 / 通用
 *  注:'通用' 由调用方追加,不在此处生成。 */
function deriveTagsForSpec(c) {
    const tags = new Set();
    if (c.pack_type) {
        if (c.pack_type.includes('细支'))
            tags.add('细支');
        if (c.pack_type.includes('中支'))
            tags.add('中支');
        if (c.pack_type.includes('短支'))
            tags.add('短支');
        if (c.pack_type.includes('爆珠'))
            tags.add('爆珠');
    }
    if (c.tier === '一类')
        tags.add('一类烟');
    if (c.tier === '二类')
        tags.add('二类烟');
    if (c.is_industrial_coop)
        tags.add('工商共育');
    // 经典款:已退市但仍有库存(滞销专区里出现的就是这类)→ 由 is_delisted 标记
    if (c.is_delisted)
        tags.add('经典款');
    return tags;
}
/** GET /api/praise-script — 经营话术
 *
 * 查询参数:
 *  - scene=怀旧专区          → 按场景过滤(常用,可单独传)
 *  - spec_ids=110105,210406  → 多 spec 联合筛选(逗号分隔):
 *                               spec 维度→target_value ∈ spec_ids
 *                               brand 维度→target_value ∈ 这批 spec 的 brand 集合
 *                               tag 维度  →target_value ∈ 这批 spec 派生的 tag 集合(+'通用')
 *                               每条返回多带 matched_specs: [{id,name}]
 *  - spec_id=110105          → 单 spec(向后兼容,不与 spec_ids 同传)
 *  - brand=中华              → 单 brand
 *  - tag=细支                → 单 tag
 *  - festival_id=dragonBoat  → festival 维度(scene 通常 '节日季节'),不与 spec_ids 同传
 *
 * 返回所有匹配话术,按 target_type 优先级排序(spec > brand > tag > festival)。
 */
router.get('/', async (req, res) => {
    const specIdsRaw = req.query.spec_ids;
    const specId = req.query.spec_id;
    const brand = req.query.brand;
    const tag = req.query.tag;
    const festivalId = req.query.festival_id;
    const scene = req.query.scene;
    const specIds = specIdsRaw
        ? specIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    if (specIds.length === 0 && !specId && !brand && !tag && !festivalId && !scene) {
        res.status(400).json({ success: false, error: '至少传 scene / spec_ids / spec_id / brand / tag / festival_id 之一' });
        return;
    }
    try {
        // ---- 计算 spec_ids 推导的 brand / tag 集合 + spec→name 映射 ----
        let derivedSpecIds = new Set();
        let derivedBrands = new Set();
        let derivedTags = new Set();
        // spec_id → 适用的 tag 集合,用于回填 matched_specs
        const specTagMap = new Map();
        // spec_id → brand,用于回填 matched_specs
        const specBrandMap = new Map();
        // spec_id → name (供前端展示)
        const specNameMap = new Map();
        if (specIds.length > 0) {
            const extMap = await (0, categoryCatalog_1.getExtendedCategoryMap)();
            for (const sid of specIds) {
                const c = extMap.get(sid) || categoryCatalog_1.categoryMap.get(sid);
                if (!c)
                    continue;
                derivedSpecIds.add(sid);
                specNameMap.set(sid, c.name);
                if (c.brand) {
                    derivedBrands.add(c.brand);
                    specBrandMap.set(sid, c.brand);
                }
                const tags = deriveTagsForSpec(c);
                specTagMap.set(sid, tags);
                for (const t of tags)
                    derivedTags.add(t);
            }
            // 通用 tag:始终适用
            derivedTags.add('通用');
        }
        // ---- 构造 SQL WHERE ----
        const conditions = [];
        const params = [];
        const orParts = [];
        if (specIds.length > 0) {
            // 三个维度并联,SQL 一次取齐
            const placeholders = specIds.map(() => '?').join(',');
            orParts.push(`(target_type = 'spec' AND target_value IN (${placeholders}))`);
            params.push(...specIds);
            if (derivedBrands.size > 0) {
                const bPh = Array.from(derivedBrands).map(() => '?').join(',');
                orParts.push(`(target_type = 'brand' AND target_value IN (${bPh}))`);
                params.push(...Array.from(derivedBrands));
            }
            if (derivedTags.size > 0) {
                const tPh = Array.from(derivedTags).map(() => '?').join(',');
                orParts.push(`(target_type = 'tag' AND target_value IN (${tPh}))`);
                params.push(...Array.from(derivedTags));
            }
        }
        else {
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
            if (festivalId) {
                orParts.push('(target_type = ? AND target_value = ?)');
                params.push('festival', festivalId);
            }
        }
        if (orParts.length > 0)
            conditions.push(`(${orParts.join(' OR ')})`);
        if (scene) {
            conditions.push('scene = ?');
            params.push(scene);
        }
        // 至少一个 WHERE 条件;只有 scene 时也能跑
        const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const [rows] = await db_1.default.execute(`SELECT id, scene, target_type, target_value, script_text
         FROM sys_praise_scripts
         ${whereSql}
        ORDER BY FIELD(target_type, 'spec', 'brand', 'tag', 'festival'), id`, params);
        // ---- 回填 matched_specs ----
        const enriched = rows.map((r) => {
            let matched = [];
            if (specIds.length > 0) {
                if (r.target_type === 'spec') {
                    if (specNameMap.has(r.target_value)) {
                        matched = [{ id: r.target_value, name: specNameMap.get(r.target_value) }];
                    }
                }
                else if (r.target_type === 'brand') {
                    for (const [sid, b] of specBrandMap) {
                        if (b === r.target_value)
                            matched.push({ id: sid, name: specNameMap.get(sid) || sid });
                    }
                }
                else if (r.target_type === 'tag') {
                    // '通用' 适用所有显示规格
                    if (r.target_value === '通用') {
                        for (const sid of derivedSpecIds)
                            matched.push({ id: sid, name: specNameMap.get(sid) || sid });
                    }
                    else {
                        for (const [sid, tagSet] of specTagMap) {
                            if (tagSet.has(r.target_value))
                                matched.push({ id: sid, name: specNameMap.get(sid) || sid });
                        }
                    }
                }
            }
            return {
                id: r.id,
                scene: r.scene,
                target_type: r.target_type,
                target_value: r.target_value,
                script_text: r.script_text,
                matched_specs: matched,
            };
        });
        res.json({ success: true, scripts: enriched });
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
