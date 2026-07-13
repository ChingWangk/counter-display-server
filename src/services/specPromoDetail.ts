import pool from '../db';
import { RowDataPacket } from 'mysql2';

/*
 * 共育政策官「产品详情表」数据源：dim_category_ext 按共育规格 id 取四列
 *   价格 price / 支型 pack_type / 口味特色 flavor / 适销人群 audience。
 * 其中 pack_type、flavor 是 dim_category_ext 既有列（已用于爆珠子专区等）；
 * price（共育展示价，面向消费者推荐）、audience（适销人群）为本次新增列。
 *
 * 降级：表未就绪（ER_NO_SUCH_TABLE）或列未补齐（ER_BAD_FIELD_ERROR）→ 返回空数组，
 * 前端据此只展示"第一/二行"布局说明、不渲染详情表（绝不硬拼空表）。
 */

export interface SpecPromoDetail {
  spec_id: string;
  price: number | null;       // 共育展示价（零售价，¥）；未补录时 null
  pack_type: string | null;   // 支型：常规 / 中支 / 细支 / 短支 / 爆珠
  flavor: string | null;      // 口味特色
  audience: string | null;    // 适销人群
}

interface DetailRow extends RowDataPacket {
  spec_id: string;
  price: string | number | null;
  pack_type: string | null;
  flavor: string | null;
  audience: string | null;
}

/**
 * 取一组规格的共育产品详情（价格/支型/口味特色/适销人群）。
 * @param ids 共育主推规格 id 列表（前端从本专区分组传入，通常已按 集团沪产→省外 排序）
 * @returns 有数据的规格详情数组（顺序不保证，前端按自己的展示顺序 join）；无表/无列/无数据 → []
 */
export async function getSpecPromoDetails(ids: string[]): Promise<SpecPromoDetail[]> {
  const cleaned = Array.from(new Set(ids.map(s => String(s).trim()).filter(Boolean)));
  if (cleaned.length === 0) return [];

  const placeholders = cleaned.map(() => '?').join(',');
  try {
    const [rows] = await pool.execute<DetailRow[]>(
      `SELECT spec_id, price, pack_type, flavor, audience
         FROM dim_category_ext
        WHERE spec_id IN (${placeholders})`,
      cleaned,
    );
    return rows.map(r => ({
      spec_id: r.spec_id,
      price: r.price === null || r.price === undefined || r.price === '' ? null : Number(r.price),
      pack_type: r.pack_type ?? null,
      flavor: r.flavor ?? null,
      audience: r.audience ?? null,
    }));
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
      console.warn('[specPromoDetail] dim_category_ext 表/列未就绪，详情表降级为空');
      return [];
    }
    console.error('[specPromoDetail] getSpecPromoDetails error:', err);
    return [];
  }
}
