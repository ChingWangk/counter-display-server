"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const router = (0, express_1.Router)();
const IMAGE_PREFIX = '/images/back-themes/';
// 启动时加载一次品类，建立 id → {imageUrl, price} 索引，用于挑选每组缩略图
const categoriesFile = path.join(__dirname, '../data/categories.json');
const allCategories = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));
const categoryMap = new Map(allCategories.map(c => [c.id, c]));
router.get('/', (req, res) => {
    const filePath = path.join(__dirname, '../data/back-cabinet-themes.json');
    const themes = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const result = themes.map(t => {
        // 取该主题组内价格最高的品规图片作为缩略图
        let topSpec;
        for (const sid of t.specIds) {
            const cat = categoryMap.get(sid);
            if (!cat)
                continue;
            if (!topSpec || cat.price > topSpec.price)
                topSpec = cat;
        }
        return {
            ...t,
            images: t.images.map(img => IMAGE_PREFIX + img),
            thumbnailImageUrl: topSpec ? topSpec.imageUrl : (IMAGE_PREFIX + t.images[0]),
        };
    });
    res.json({ success: true, themes: result });
});
exports.default = router;
