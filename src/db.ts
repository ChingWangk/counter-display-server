import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: 'counter_user',
  password: '1832759229',
  database: 'counter_display',
  waitForConnections: true,
  connectionLimit: 10,
});

export default pool;
