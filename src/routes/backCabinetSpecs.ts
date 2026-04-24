import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

interface ThemeGroup {
  id: string;
  label: string;
  specIds: string[];
  images: string[];
}

const router = Router();

const IMAGE_PREFIX = '/images/back-themes/';

router.get('/', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, '../data/back-cabinet-themes.json');
  const themes: ThemeGroup[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  const result = themes.map(t => ({
    ...t,
    images: t.images.map(img => IMAGE_PREFIX + img),
  }));

  res.json({ success: true, themes: result });
});

export default router;
