"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promise_1 = __importDefault(require("mysql2/promise"));
const pool = promise_1.default.createPool({
    host: '127.0.0.1',
    port: 3306,
    user: 'counter_user',
    password: '1832759229',
    database: 'counter_display',
    waitForConnections: true,
    connectionLimit: 10,
});
exports.default = pool;
