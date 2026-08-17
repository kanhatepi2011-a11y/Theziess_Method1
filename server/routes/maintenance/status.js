import { DEFAULT_MAINTENANCE_MESSAGE, getMaintenanceState } from "../_db.js";

export default async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({
            ok: false,
            code: "METHOD_NOT_ALLOWED",
            error: "Method not allowed.",
        });
    }

    res.setHeader("Cache-Control", "public, no-store, max-age=0");

    try {
        const maintenance = await getMaintenanceState();
        return res.status(200).json({ ok: true, maintenance });
    } catch (error) {
        // Fail open: a transient database problem must not accidentally lock every
        // visitor out of the website.
        console.error(
            "Unable to read maintenance state:",
            error?.message || error,
        );
        return res.status(200).json({
            ok: true,
            degraded: true,
            maintenance: {
                enabled: false,
                message: DEFAULT_MAINTENANCE_MESSAGE,
                updatedBy: null,
                updatedAt: null,
            },
        });
    }
}
