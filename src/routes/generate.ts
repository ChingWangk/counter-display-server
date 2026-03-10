import { Router, Request, Response } from 'express';
import { GenerateRequest, GenerateResponse } from '../types';
import { mockGenerate } from '../services/imageGen';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  const { counters, categories } = req.body as GenerateRequest;

  if (!Array.isArray(counters) || counters.length === 0) {
    const body: GenerateResponse = { success: false, error: '柜台列表不能为空' };
    res.status(400).json(body);
    return;
  }

  if (!Array.isArray(categories) || categories.length === 0) {
    const body: GenerateResponse = { success: false, error: '品类列表不能为空' };
    res.status(400).json(body);
    return;
  }

  const results = mockGenerate(counters);
  const body: GenerateResponse = { success: true, results };
  res.json(body);
});

export default router;
