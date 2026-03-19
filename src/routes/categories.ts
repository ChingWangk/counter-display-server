import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, '../data/categories.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  res.json({ success: true, categories: data });
});

export default router;