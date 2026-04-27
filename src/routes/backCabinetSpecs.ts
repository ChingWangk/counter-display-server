import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

interface ThemeGroup {
  id: string;
  label: string;
  specIds: string[];
  images: string[];
}

interface CategoryLite {
  id: string;
  imageUrl: string;
  price: number;
}

const router = Router();

const IMAGE_PREFIX = '/images/back-themes/';

// 启动时加载一次品类，建立 id → {imageUrl, price} 索引，用于挑选每组缩略图
const categoriesFile = path.join(__dirname, '../data/categories.json');
const allCategories: CategoryLite[] = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));
const categoryMap = new Map(allCategories.map(c => [c.id, c]));

router.get('/', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, '../data/back-cabinet-themes.json');
  const themes: ThemeGroup[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  const result = themes.map(t => {
    // 取该主题组内价格最高的品规图片作为缩略图
    let topSpec: CategoryLite | undefined;
    for (const sid of t.specIds) {
      const cat = categoryMap.get(sid);
      if (!cat) continue;
      if (!topSpec || cat.price > topSpec.price) topSpec = cat;
    }

    return {
      ...t,
      images: t.images.map(img => IMAGE_PREFIX + img),
      thumbnailImageUrl: topSpec ? topSpec.imageUrl : (IMAGE_PREFIX + t.images[0]),
    };
  });

  res.json({ success: true, themes: result });
});

export default router;
