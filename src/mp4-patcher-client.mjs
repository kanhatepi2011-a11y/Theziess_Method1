let worker = null;
let sequence = 0;
const pending = new Map();

function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("./mp4-patcher-worker.mjs", import.meta.url), {
        type: "module",
    });
    worker.onmessage = ({ data }) => {
        const task = pending.get(data?.id);
        if (!task) return;
        pending.delete(data.id);
        if (data.ok) task.resolve(data);
        else task.reject(new Error(data.error || "MP4 patch failed"));
    };
    worker.onerror = (event) => {
        const error = new Error(event.message || "MP4 patch worker crashed");
        for (const task of pending.values()) task.reject(error);
        pending.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}

export function patchAudioInflationInWorker(buffer, options = {}) {
    const transferable = buffer.slice(0);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, buffer: transferable, options }, [transferable]);
    });
}

export function terminateMp4PatcherWorker() {
    worker?.terminate();
    worker = null;
    for (const task of pending.values()) task.reject(new Error("MP4 patcher stopped"));
    pending.clear();
}
