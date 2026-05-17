import * as fs from 'fs';
import * as path from 'path';
import { Category } from '../types';

/** 全量品类目录单例：进程启动时加载一次，所有策略/路由共用同一份引用。 */
const categoriesFile = path.join(__dirname, '../data/categories.json');
const allCategories: Category[] = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));

export const categoryMap = new Map<string, Category>(allCategories.map(c => [c.id, c]));
export const allCategoryList: ReadonlyArray<Category> = allCategories;
