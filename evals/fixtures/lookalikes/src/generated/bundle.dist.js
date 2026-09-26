"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dist = void 0;
/** Built output that is unrelated to the handlers: a tiny event bus. */
function dist() {
    const listeners = new Map();
    return {
        on(name, fn) {
            const list = listeners.get(name) ?? [];
            list.push(fn);
            listeners.set(name, list);
        },
        emit(name, payload) {
            for (const fn of listeners.get(name) ?? []) fn(payload);
        },
    };
}
exports.dist = dist;
