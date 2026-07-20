import pool from '../db';
import { RowDataPacket } from 'mysql2';

/**
 * 客户消费客群结构档位（cust_consumer_structure.structure_level）。
 *
 * 数据来源：杨浦公司客户经营能力调研问卷第五题「门店主要的消费客户群体」，
 * 由 scripts/build_customer_consumer_structure.py 归档落库（①居民=low / ②商务人士=high /
 * ③特殊群体按自由填写字段判定）。
 *
 * 用途：尝鲜专区**核心区域（店长推荐）**上柜哪 6 个规格按本档位切换，
 * 见 strategies/zones.ts::MANAGER_PICK_BY_LEVEL 与
 * docs/尝鲜专区核心区域-按消费结构分档方案.md。
 */
export type ConsumerStructureLevel = 'high' | 'mid_high' | 'low';

const VALID: ReadonlySet<string> = new Set(['high', 'mid_high', 'low']);

interface LevelRow extends RowDataPacket {
  structure_level: string | null;
}

/**
 * 查客户的消费结构档位。
 *
 * 返回 null 的每一种情形都会让调用方回退到现网默认的店长推荐规格（不猜档）：
 *  - 客户号为空 / 表里查无此人（新入网客户）
 *  - structure_level 为 NULL（问卷选了"特殊群体"却没写具体类别）
 *  - cust_consumer_structure 表尚未建（本地开发库）
 *  - 库里存了预期外的值
 */
export async function getCustomerStructureLevel(
  customerId: string,
): Promise<ConsumerStructureLevel | null> {
  if (!customerId) return null;
  try {
    const [rows] = await pool.execute<LevelRow[]>(
      'SELECT structure_level FROM cust_consumer_structure WHERE customer_id = ?',
      [customerId],
    );
    if (rows.length === 0) return null;
    const lvl = rows[0].structure_level;
    if (!lvl || !VALID.has(lvl)) return null;
    return lvl as ConsumerStructureLevel;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[customerStructure] cust_consumer_structure 表未就绪，店长推荐走默认规格');
      return null;
    }
    console.error('[customerStructure] getCustomerStructureLevel error:', err);
    return null;
  }
}
