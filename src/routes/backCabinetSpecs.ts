import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, '../data/back-cabinet-specs.json');
  const ids: string[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  res.json({ success: true, specs: ids });
});

export default router;
