"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInvoices = exports.getRefunds = exports.getOrders = void 0;
/** Framework handlers with an identical shape; each reads a different table. */
async function getOrders(req, res) {
    const page = Number(req.query.page ?? 1);
    const rows = await req.app.locals.db.from('orders').where('user_id', req.params.userId).page(page);
    res.status(200).json({ page, rows });
}
exports.getOrders = getOrders;
async function getRefunds(req, res) {
    const page = Number(req.query.page ?? 1);
    const rows = await req.app.locals.db.from('refunds').where('user_id', req.params.userId).page(page);
    res.status(200).json({ page, rows });
}
exports.getRefunds = getRefunds;
async function getInvoices(req, res) {
    const page = Number(req.query.page ?? 1);
    const rows = await req.app.locals.db.from('invoices').where('user_id', req.params.userId).page(page);
    res.status(200).json({ page, rows });
}
exports.getInvoices = getInvoices;
