import {
    clearAllRecords,
    deleteRecord,
    getAllRecords,
    saveRecord,
} from "./db.js";
import { initChangelog } from "./src/changelog.mjs";
import {
    detectVideoCodecFromMoov,
    findHandlerType,
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./src/mp4-boxes.mjs";
import { patchAudioInflationInWorker } from "./src/mp4-patcher-client.mjs";
import {
    formatRealFps,
    inspectMp4ForTikTok,
    validateTikTokArtifact,
} from "./src/tiktok-upload.mjs";

const FRAME_CAPTURE_TIMEOUT_MS = 5000;
const METADATA_TIMEOUT_MS = 10000;
const MAX_THUMBNAIL_DIMENSION = 120;
const MOBILE_BREAKPOINT = 900;
const DOWNLOAD_REVOKE_DELAY_MS = 1000;
const PROGRESS_HIDE_DELAY_MS = 800;
const PROGRESS_FADE_DURATION_MS = 400;
const DOWNLOAD_INTERVAL_MS = 300;
const PATCH_INTERVAL_MS = 600;
const MOBILE_SCROLL_DELAY_MS = 150;
const DOWNLOAD_ANCHOR_CLEANUP_MS = 100;
const SAFE_THUMBNAIL_PREFIX = "data:image/jpeg;base64,";
const LOCAL_STANDALONE_MODE = false;
const TELEGRAM_USER_STORAGE_KEY = "theziess.telegram.user";
const TELEGRAM_CONNECTED_AT_KEY = "theziess.telegram.connectedAt";
const TELEGRAM_FALLBACK_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function readStoredTelegramUser() {
    try {
        const connectedAt = Number(localStorage.getItem(TELEGRAM_CONNECTED_AT_KEY));
        const rawUser = localStorage.getItem(TELEGRAM_USER_STORAGE_KEY);

        if (!rawUser || !Number.isFinite(connectedAt)) return null;

        if (Date.now() - connectedAt > TELEGRAM_FALLBACK_MAX_AGE_MS) {
            clearStoredTelegramUser();
            return null;
        }

        const user = JSON.parse(rawUser);
        if (!user || typeof user !== "object" || !String(user.id || "").trim()) {
            clearStoredTelegramUser();
            return null;
        }

        return {
            id: String(user.id),
            databaseId: String(user.databaseId || ""),
            first_name: String(user.first_name || ""),
            last_name: String(user.last_name || ""),
            username: String(user.username || ""),
            photo_url: String(user.photo_url || ""),
        };
    } catch (error) {
        console.warn("Unable to read saved Telegram login", error);
        return null;
    }
}

function storeTelegramUser(user) {
    if (!user) return;

    try {
        localStorage.setItem(TELEGRAM_USER_STORAGE_KEY, JSON.stringify(user));
        localStorage.setItem(TELEGRAM_CONNECTED_AT_KEY, String(Date.now()));
    } catch (error) {
        console.warn("Unable to save Telegram login", error);
    }
}

function clearStoredTelegramUser() {
    try {
        localStorage.removeItem(TELEGRAM_USER_STORAGE_KEY);
        localStorage.removeItem(TELEGRAM_CONNECTED_AT_KEY);
    } catch (error) {
        console.warn("Unable to clear Telegram login", error);
    }
}

const TELEGRAM_BOT_BOOTSTRAP_KEY = "theziess.telegram.botBootstrapAt.v11";
const TELEGRAM_BOT_BOOTSTRAP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function autoConnectTelegramAdminBot() {
    try {
        const lastBootstrapAt = Number(
            localStorage.getItem(TELEGRAM_BOT_BOOTSTRAP_KEY) || 0,
        );

        if (
            Number.isFinite(lastBootstrapAt) &&
            Date.now() - lastBootstrapAt < TELEGRAM_BOT_BOOTSTRAP_INTERVAL_MS
        ) {
            return;
        }

        const response = await fetch("/api/telegram/setup", {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "X-TheZiess-Auto-Setup": "1",
            },
            body: JSON.stringify({ automatic: true }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.ok) {
            console.warn(
                "Telegram admin bot auto-connect is not ready:",
                data.error || data.message || response.status,
            );
            return;
        }

        localStorage.setItem(
            TELEGRAM_BOT_BOOTSTRAP_KEY,
            String(Date.now()),
        );
    } catch (error) {
        console.warn("Unable to auto-connect Telegram admin bot", error);
    }
}

async function reportCompressionActivity({
    inputName,
    outputName,
    inputBytes,
    outputBytes,
    outputMime,
}) {
    if (!currentUser) return;

    try {
        await fetch("/api/activity/compression", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                inputName,
                outputName,
                inputBytes,
                outputBytes,
                outputMime,
            }),
        });
    } catch (error) {
        console.warn("Unable to save compression activity", error);
    }
}


const supportedMimeTypes = [
    "video/mp4",
    "video/quicktime",
    "video/x-quicktime",
];
const supportedExtensions = [".mp4", ".mov"];

const fileInput = document.getElementById("fileInput");
const patchBtn = document.getElementById("patchBtn");
const clearBtn = document.getElementById("clearBtn");
const dropZone = document.getElementById("dropZone");
const statusLog = document.getElementById("statusLog");
const progressBar = document.getElementById("progressBar");
const progressTrack = document.getElementById("progressTrack");
const fileListEl = document.getElementById("fileList");
const historyList = document.getElementById("historyList");
const historyBadge = document.getElementById("historyBadge");
const historyHeader = document.getElementById("historyHeader");
const historySection = document.getElementById("historySection");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const queueAndActionsWrapper = document.querySelector(".queue-and-actions-wrapper");
const systemStatusPanel = document.querySelector(".panel-log");
const videoCheckSection = document.getElementById("videoCheckSection");
const videoCheckForm = document.getElementById("videoCheckForm");
const videoCheckUrl = document.getElementById("videoCheckUrl");
const videoCheckSubmitBtn = document.getElementById("videoCheckSubmitBtn");
const videoCheckPasteBtn = document.getElementById("videoCheckPasteBtn");
const videoCheckStatus = document.getElementById("videoCheckStatus");
const videoCheckResult = document.getElementById("videoCheckResult");

let selectedFiles = [];
let currentFlowState = "idle";
let isCancelled = false;
let processingFiles = false;
let lastPatchedVfi = false;
let lastPatchedRes = "1080";

let currentUser = null;
let currentSubscription = null;
let currentTikTokAccount = null;
let pendingPlan = null;
let pendingTikTokUpload = null;
let pendingTikTokStatusCheck = null;
let activeTikTokUploadController = null;
let activeTikTokUploadPromise = null;
let activeTikTokPublishId = null;
let tiktokUploadPreviewUrl = null;

const PLANS = {
    free: { id: "free", name: "FREE", price: "$0", durationLabel: "3 days", days: 3, adminOnly: false },
    pro: { id: "pro", name: "PRO", price: "$3", durationLabel: "30 days", days: 30, adminOnly: true },
    premium: { id: "premium", name: "PREMIUM", price: "$5", durationLabel: "180 days", days: 180, adminOnly: true },
    max: { id: "max", name: "MAX", price: "$10", durationLabel: "1 year", days: 365, adminOnly: true },
};

function hasActiveSubscription() {
    if (!currentUser || !currentSubscription) {
        return false;
    }

    if (currentSubscription.status !== "active") {
        return false;
    }

    return Number(currentSubscription.expiresAt) > Date.now();
}

function formatSubscriptionExpiry(subscription) {
    if (!subscription) return "No active subscription";
    return `${PLANS[subscription.planId]?.name || "PLAN"} · until ${new Date(subscription.expiresAt).toLocaleDateString()}`;
}

function getTelegramDisplayName(user) {
    if (!user) return "Telegram User";
    const fullName = [user.first_name, user.last_name]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join(" ");
    return fullName || user.username || "Telegram User";
}

function getTelegramInitials(user) {
    const displayName = getTelegramDisplayName(user);
    const initials = displayName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("");
    return initials || "T";
}

function setElementText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function updateTelegramProfileUI(loggedIn, active) {
    const displayName = getTelegramDisplayName(currentUser);
    const username = currentUser?.username
        ? `@${currentUser.username}`
        : loggedIn
          ? "No public username"
          : "Not connected";
    const photoUrl = String(currentUser?.photo_url || "").trim();
    const plan = active ? PLANS[currentSubscription?.planId] : null;

    const accountCard = document.getElementById("telegramAccountCard");
    const accountPhoto = document.getElementById("telegramAccountPhoto");
    const profileAvatar = document.getElementById("profileAvatar");
    const profileInitials = document.getElementById("profileInitials");
    const profileConnectionStatus = document.getElementById("profileConnectionStatus");
    const profilePlanBadge = document.getElementById("profilePlanBadge");
    const profileConnectedIndicator = document.querySelector(".profile-connected-indicator");
    const navProfileDot = document.getElementById("navProfileDot");

    if (accountCard) accountCard.hidden = !loggedIn;
    setElementText("telegramAccountName", displayName);
    setElementText("telegramAccountUsername", username);
    setElementText(
        "telegramAccountPlan",
        active
            ? formatSubscriptionExpiry(currentSubscription)
            : loggedIn
              ? "No active subscription"
              : "Login required",
    );

    const configurePhoto = (image, initialsElement = null) => {
        if (!image) return;
        if (loggedIn && photoUrl) {
            image.src = photoUrl;
            image.hidden = false;
            if (initialsElement) initialsElement.hidden = true;
            image.onerror = () => {
                image.hidden = true;
                image.removeAttribute("src");
                if (initialsElement) initialsElement.hidden = false;
            };
        } else {
            image.hidden = true;
            image.removeAttribute("src");
            if (initialsElement) initialsElement.hidden = false;
        }
    };

    configurePhoto(accountPhoto);
    configurePhoto(profileAvatar, profileInitials);

    if (profileInitials) {
        profileInitials.textContent = getTelegramInitials(currentUser);
        profileInitials.hidden = loggedIn && Boolean(photoUrl);
    }

    setElementText("profileName", loggedIn ? displayName : "Telegram User");
    setElementText("profileUsername", username);
    setElementText("profileTelegramId", loggedIn ? String(currentUser.id || "—") : "—");
    setElementText(
        "profileAccessLevel",
        active
            ? "Compressor unlocked"
            : loggedIn
              ? "Subscription required"
              : "Login required",
    );
    setElementText("profileConnectionStatus", loggedIn ? "Telegram connected" : "Telegram not connected");

    if (profileConnectionStatus) {
        profileConnectionStatus.classList.toggle("offline", !loggedIn);
    }
    if (profileConnectedIndicator) profileConnectedIndicator.hidden = !loggedIn;
    if (navProfileDot) navProfileDot.hidden = !loggedIn;

    if (active && plan) {
        const isFreeTrial = currentSubscription.planId === "free";
        setElementText("profilePlanName", plan.name);
        setElementText(
            "profilePlanBadge",
            isFreeTrial ? "Free trial active" : "Subscription active",
        );
        setElementText("profilePlanStatus", "Active");
        setElementText(
            "profilePlanExpiry",
            new Date(currentSubscription.expiresAt).toLocaleDateString(),
        );
        setElementText(
            "profilePlanDescription",
            isFreeTrial
                ? "Your one-time 3-day free trial is active."
                : `${plan.name} is active. Payment method: ${currentSubscription.paymentMethod || "KHQR"}.`,
        );
        profilePlanBadge?.classList.toggle("premium", !isFreeTrial);
        profilePlanBadge?.classList.toggle("trial", isFreeTrial);
    } else if (loggedIn) {
        setElementText("profilePlanName", "NO PLAN");
        setElementText("profilePlanBadge", "Subscription required");
        setElementText("profilePlanStatus", "Inactive");
        setElementText("profilePlanExpiry", "—");
        setElementText(
            "profilePlanDescription",
            "Start the FREE 3-day trial yourself. PRO, PREMIUM, and MAX must be assigned by an administrator.",
        );
        profilePlanBadge?.classList.remove("premium", "trial");
    } else {
        setElementText("profilePlanName", "NOT CONNECTED");
        setElementText("profilePlanBadge", "Login required");
        setElementText("profilePlanStatus", "Inactive");
        setElementText("profilePlanExpiry", "—");
        setElementText(
            "profilePlanDescription",
            "Connect your Telegram account to unlock the video compressor and view subscription details.",
        );
        profilePlanBadge?.classList.remove("premium", "trial");
    }

    const profileLoginBtn = document.getElementById("profileLoginBtn");
    const profilePlansBtn = document.getElementById("profilePlansBtn");
    const profileLogoutBtn = document.getElementById("profileLogoutBtn");
    if (profileLoginBtn) profileLoginBtn.hidden = LOCAL_STANDALONE_MODE || loggedIn;
    if (profilePlansBtn) profilePlansBtn.hidden = LOCAL_STANDALONE_MODE || !loggedIn;
    if (profileLogoutBtn) profileLogoutBtn.hidden = LOCAL_STANDALONE_MODE || !loggedIn;

    const profilePlansInlineBtn = document.getElementById("profilePlansInlineBtn");
    if (profilePlansInlineBtn) profilePlansInlineBtn.hidden = false;
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    // Force layout so the active transition works even when the element was hidden.
    void modal.offsetWidth;
    modal.classList.add("active");
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
    window.setTimeout(() => {
        if (!modal.classList.contains("active")) modal.hidden = true;
    }, 220);
}

function configurePlanActivationModal(plan) {
    const isFreeTrial = plan?.id === "free";
    const isAdminOnly = Boolean(plan?.adminOnly);
    const paymentBody = document.getElementById("paymentBody");
    const khqrCard = document.getElementById("khqrCard");
    const paymentNotice = document.getElementById("paymentNotice");
    const confirmButton = document.getElementById("confirmPaymentBtn");

    setElementText(
        "paymentModalTitle",
        isFreeTrial ? "Activate 3-Day Free Trial" : "Admin Activation Required",
    );
    setElementText("paymentAmount", plan?.price || "$0");
    setElementText("paymentPlanName", plan?.name || "—");
    setElementText("paymentDuration", plan?.durationLabel || "—");

    paymentBody?.classList.toggle("free-trial-mode", isFreeTrial);
    paymentBody?.classList.toggle("admin-only-mode", isAdminOnly);
    if (khqrCard) khqrCard.hidden = true;
    if (paymentNotice) {
        paymentNotice.classList.remove("error");
        paymentNotice.textContent = isFreeTrial
            ? "This free trial can be activated once per Telegram account. The 3-day period starts immediately after confirmation."
            : `${plan?.name || "This paid plan"} cannot be claimed for free. Only an administrator can assign it through the Telegram bot. Your Telegram ID is ${currentUser?.id || "unknown"}.`;
    }
    if (confirmButton) {
        confirmButton.dataset.activationMode = isFreeTrial ? "free" : "admin-only";
        confirmButton.textContent = isFreeTrial
            ? "Start 3-Day Free Trial"
            : "Check Subscription";
    }
}
function setSubscriptionPlansOpen(open, { scroll = true } = {}) {
    const panel = document.getElementById("subscriptionPanel");
    const hint = document.getElementById("patchAccessHint");
    if (!panel) return;

    panel.hidden = !open;
    panel.setAttribute("aria-hidden", String(!open));
    hint?.setAttribute("aria-expanded", String(open));

    if (open && scroll) {
        requestAnimationFrame(() => {
            panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
            panel.classList.remove("plans-reveal");
            void panel.offsetWidth;
            panel.classList.add("plans-reveal");
        });
    }
}

function showSubscriptionPlans() {
    openModal("profileModal");
    setSubscriptionPlansOpen(true);
}

function hideSubscriptionPlans() {
    setSubscriptionPlansOpen(false, { scroll: false });
}

function toggleSubscriptionPlans() {
    const panel = document.getElementById("subscriptionPanel");
    if (!panel) return;
    setSubscriptionPlansOpen(panel.hidden);
}

function updateAccessUI() {
    if (LOCAL_STANDALONE_MODE) {
        document.body.classList.add("access-granted");
        const lock = document.getElementById("accessLock");
        if (lock) lock.hidden = true;
        const loginBtn = document.getElementById("telegramLoginBtn");
        const logoutBtn = document.getElementById("logoutBtn");
        const accountCard = document.getElementById("telegramAccountCard");
        const subscriptionPanel = document.getElementById("subscriptionPanel");
        const subscriptionStatus = document.getElementById("subscriptionStatus");
        if (loginBtn) loginBtn.hidden = true;
        if (logoutBtn) logoutBtn.hidden = true;
        if (accountCard) accountCard.hidden = true;
        if (subscriptionPanel) {
            subscriptionPanel.hidden = true;
            subscriptionPanel.setAttribute("aria-hidden", "true");
        }
        const accessHint = document.getElementById("patchAccessHint");
        if (accessHint) {
            accessHint.hidden = true;
            accessHint.setAttribute("aria-expanded", "false");
        }
        if (subscriptionStatus) {
            subscriptionStatus.textContent = "Test mode — unlocked";
            subscriptionStatus.classList.add("active");
            subscriptionStatus.classList.remove("required");
        }
        updateTikTokAccountUI();
        updatePatchButton();
        return;
    }

    const loggedIn = !!currentUser;
    const active = hasActiveSubscription();
    const accountLabel = document.getElementById("accountLabel");
    const loginBtn = document.getElementById("telegramLoginBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const subscriptionStatus = document.getElementById("subscriptionStatus");
    const lock = document.getElementById("accessLock");
    if (accountLabel) accountLabel.textContent = LOCAL_STANDALONE_MODE
        ? "Local mode"
        : loggedIn
          ? `@${currentUser?.username || currentUser?.first_name || "telegram_user"}`
          : "មិនទាន់ចូលគណនី";
    if (loginBtn) loginBtn.hidden = LOCAL_STANDALONE_MODE || loggedIn;
    if (logoutBtn) logoutBtn.hidden = LOCAL_STANDALONE_MODE || !loggedIn;
    if (subscriptionStatus) {
        subscriptionStatus.textContent = active
            ? formatSubscriptionExpiry(currentSubscription)
            : loggedIn
              ? "Subscription required"
              : "Login required";
        subscriptionStatus.classList.toggle("active", active);
        subscriptionStatus.classList.toggle("connected", false);
        subscriptionStatus.classList.toggle("required", loggedIn && !active);
    }
    document.querySelectorAll(".plan-card").forEach((card) => {
        const plan = PLANS[card.dataset.plan];
        const isCurrent = active && card.dataset.plan === currentSubscription?.planId;
        const freeBlockedByActivePlan = active && card.dataset.plan === "free";
        card.classList.toggle("current", isCurrent);
        card.classList.toggle("admin-only", Boolean(plan?.adminOnly));
        card.disabled = freeBlockedByActivePlan;
        if (freeBlockedByActivePlan) {
            card.title = isCurrent
                ? "Your free trial is already active."
                : "You already have an active subscription.";
        } else if (plan?.adminOnly) {
            card.title = `${plan.name} can only be assigned by an administrator.`;
        } else {
            card.removeAttribute("title");
        }
    });

    // Telegram login unlocks the account area, but video compression requires
    // a currently active subscription. The full-page lock remains login-only.
    document.body.classList.toggle("access-granted", true);
    if (lock) lock.hidden = true;
    updateTelegramProfileUI(loggedIn, active);
    updateTikTokAccountUI();
    updatePatchButton();
}

function requireLogin() {
    if (LOCAL_STANDALONE_MODE) return true;
    if (currentUser) return true;
    openModal("telegramModal");
    updateAccessUI();
    return false;
}

function requireActiveSubscription({ focusPlans = true } = {}) {
    if (LOCAL_STANDALONE_MODE) return true;
    if (!requireLogin()) return false;
    if (hasActiveSubscription()) return true;

    logMessage(
        "Start the FREE 3-day trial or ask an administrator to assign PRO, PREMIUM, or MAX before compressing videos.",
        "warning",
    );

    if (focusPlans) {
        showSubscriptionPlans();
    }

    updateAccessUI();
    return false;
}

async function loadServerSession({ retries = 2, preserveExistingSubscription = false } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await fetch(`/api/auth/me?t=${Date.now()}`, {
                credentials: "include",
                cache: "no-store",
                headers: { Accept: "application/json" },
            });

            if (!response.ok) {
                throw new Error(`Unable to read login session (${response.status})`);
            }

            const data = await response.json();

            if (data.authenticated && data.user) {
                currentUser = data.user;
                currentSubscription = data.subscription ||
                    (preserveExistingSubscription && hasActiveSubscription()
                        ? currentSubscription
                        : null);
                storeTelegramUser(data.user);
                updateAccessUI();
                return true;
            }

            const storedUser = readStoredTelegramUser();
            currentUser = storedUser;
            currentSubscription =
                preserveExistingSubscription && hasActiveSubscription()
                    ? currentSubscription
                    : null;
            updateAccessUI();
            return Boolean(storedUser);
        } catch (error) {
            lastError = error;

            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
            }
        }
    }

    const storedUser = readStoredTelegramUser();
    currentUser = storedUser;
    currentSubscription =
        preserveExistingSubscription && hasActiveSubscription()
            ? currentSubscription
            : null;

    if (lastError) {
        console.warn("Server session unavailable; using Telegram browser fallback", lastError);
    }

    updateAccessUI();
    return Boolean(storedUser);
}


async function initializeMembership() {
    
    const params = new URLSearchParams(location.search);
    const returningFromTelegram = params.get("telegram_login") === "success";
    await loadServerSession({ retries: returningFromTelegram ? 4 : 2 });
    await loadTikTokAccount();

    const tiktokResult = params.get("tiktok");
    if (tiktokResult) {
        params.delete("tiktok");
        history.replaceState({}, "", `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`);
        if (tiktokResult === "connected") {
            await loadTikTokAccount();
            logMessage("TikTok account connected. You can now upload clean videos to Inbox/Draft.", "success");
        } else {
            logMessage("TikTok connection was not completed. Please try again and approve both permissions.", "error");
        }
    }

    if (params.get("telegram_login") === "success") {
        params.delete("telegram_login");
        history.replaceState({}, "", `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`);
        if (currentUser) {
            logMessage(
                hasActiveSubscription()
                    ? "Telegram account verified. Your subscription is active."
                    : "Telegram account verified. Choose a subscription plan to enable compression.",
                hasActiveSubscription() ? "success" : "warning",
            );
        } else {
            logMessage("Telegram returned successfully, but the login session could not be loaded. Please try logging in again.", "error");
        }
    }
    document.getElementById("telegramLoginBtn")?.addEventListener("click", () => openModal("telegramModal"));

    const telegramOidcLoginBtn = document.getElementById("telegramOidcLoginBtn");
    const telegramLoginError = document.getElementById("telegramLoginError");
    const telegramCallbackUrl = document.getElementById("telegramCallbackUrl");

    if (telegramCallbackUrl) {
        telegramCallbackUrl.textContent = `${location.origin}/api/auth/telegram/callback`;
    }

    const resetTelegramLoginButton = () => {
        if (!telegramOidcLoginBtn) return;
        telegramOidcLoginBtn.disabled = false;
        telegramOidcLoginBtn.removeAttribute("aria-busy");
        const label = telegramOidcLoginBtn.querySelector("span");
        if (label) label.textContent = "Continue with Telegram";
    };

    telegramOidcLoginBtn?.addEventListener("click", () => {
        if (telegramLoginError) {
            telegramLoginError.hidden = true;
            telegramLoginError.textContent = "";
        }

        telegramOidcLoginBtn.disabled = true;
        telegramOidcLoginBtn.setAttribute("aria-busy", "true");
        const label = telegramOidcLoginBtn.querySelector("span");
        if (label) label.textContent = "Connecting to Telegram…";

        // Start the server-side OIDC + PKCE flow. The previous build had no
        // click handler here, so the button looked active but did nothing.
        window.location.assign("/api/auth/telegram");
    });

    // Browsers may restore the page from the back-forward cache after a user
    // cancels Telegram login. Re-enable the button in that case.
    window.addEventListener("pageshow", resetTelegramLoginButton);

    document.getElementById("openPlansBtn")?.addEventListener("click", showSubscriptionPlans);
    document.getElementById("closeSubscriptionPlansBtn")?.addEventListener("click", hideSubscriptionPlans);
    document.getElementById("logoutBtn")?.addEventListener("click", async () => {
        try {
            await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "include",
                cache: "no-store",
            });
        } catch (error) {
            console.warn("Server logout failed; clearing local login anyway", error);
        }

        clearStoredTelegramUser();
        currentUser = null;
        currentSubscription = null;
        currentTikTokAccount = null;
        updateAccessUI();
    });
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.closeModal)));
    document.querySelectorAll(".plan-card").forEach((card) => card.addEventListener("click", () => {
        if (!LOCAL_STANDALONE_MODE && !currentUser) { openModal("telegramModal"); return; }
        pendingPlan = PLANS[card.dataset.plan];
        if (!pendingPlan) return;
        configurePlanActivationModal(pendingPlan);
        openModal("paymentModal");
    }));
    document.getElementById("confirmPaymentBtn")?.addEventListener("click", async () => {
        if (!pendingPlan || !currentUser) return;

        const button = document.getElementById("confirmPaymentBtn");
        const activatedPlan = pendingPlan;
        const originalLabel = button.textContent;
        const paymentNotice = document.getElementById("paymentNotice");

        button.disabled = true;
        button.setAttribute("aria-busy", "true");

        // Paid plans are activated manually by the administrator. Send the
        // selected plan details directly to @thephal in Telegram.
        if (activatedPlan.adminOnly) {
            const telegramUsername = "thephal";
            const message = [
                "ជំរាបសួរបង👋",
                "",
                "ខ្ញុំចង់ទិញ៖",
                `Plan : ${activatedPlan.name || "—"}`,
                `Price: ${activatedPlan.price || "—"}`,
                `Expired: ${activatedPlan.durationLabel || "—"}`,
            ].join("\n");
            const telegramUrl = `https://t.me/${telegramUsername}?text=${encodeURIComponent(message)}`;

            if (paymentNotice) {
                paymentNotice.classList.remove("error");
                paymentNotice.textContent = `Opening Telegram chat with @${telegramUsername}…`;
            }

            // Location navigation is more reliable than window.open on mobile
            // browsers because it is executed directly from the user's click.
            window.location.href = telegramUrl;

            button.disabled = false;
            button.removeAttribute("aria-busy");
            button.textContent = originalLabel;
            return;
        }

        button.textContent = "Activating Free Trial…";

        if (paymentNotice) {
            paymentNotice.classList.remove("error");
            paymentNotice.textContent = "Activating your 3-day free trial. Please wait…";
        }

        try {
            const response = await fetch(`/api/subscription/activate-demo?t=${Date.now()}`, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({ planId: "free" }),
            });

            const rawBody = await response.text();
            let data = {};

            try {
                data = rawBody ? JSON.parse(rawBody) : {};
            } catch {
                throw new Error("The server returned an invalid activation response.");
            }

            if (!response.ok) {
                throw new Error(data.error || "Free-trial activation failed.");
            }

            if (data.subscription?.planId !== "free" || data.subscription.status !== "active") {
                throw new Error("The free trial was not activated correctly. Please try again.");
            }

            currentSubscription = data.subscription;
            pendingPlan = null;
            updateAccessUI();
            closeModal("paymentModal");
            hideSubscriptionPlans();
            logMessage("Your 3-day free trial is active. Compression is now unlocked.", "success");

            await loadServerSession({
                retries: 3,
                preserveExistingSubscription: true,
            });
        } catch (error) {
            await loadServerSession({
                retries: 2,
                preserveExistingSubscription: true,
            });

            const recovered = hasActiveSubscription() &&
                currentSubscription?.planId === "free";

            if (recovered) {
                pendingPlan = null;
                closeModal("paymentModal");
                hideSubscriptionPlans();
                updateAccessUI();
                logMessage("Your 3-day free trial is active. Compression is now unlocked.", "success");
                return;
            }

            if (paymentNotice) {
                paymentNotice.textContent = error.message;
                paymentNotice.classList.add("error");
            }
            logMessage(error.message, "error");
        } finally {
            button.disabled = false;
            button.removeAttribute("aria-busy");
            button.textContent = originalLabel;
        }
    });
    document.getElementById("patchAccessHint")?.addEventListener("click", () => {
        if (LOCAL_STANDALONE_MODE) return;
        if (!currentUser) {
            openModal("telegramModal");
            return;
        }
        toggleSubscriptionPlans();
    });
    document.getElementById("lockActionBtn")?.addEventListener("click", () => {
        if (!LOCAL_STANDALONE_MODE) openModal("telegramModal");
    });

    // When an administrator grants or revokes a plan while this page is open,
    // refresh access automatically when the user returns to the tab/window.
    let lastMembershipRefreshAt = 0;
    const refreshMembershipOnReturn = () => {
        if (!currentUser || Date.now() - lastMembershipRefreshAt < 1500) return;
        lastMembershipRefreshAt = Date.now();
        loadServerSession({ retries: 1 }).catch((error) => {
            console.warn("Unable to refresh subscription status", error);
        });
    };
    window.addEventListener("focus", refreshMembershipOnReturn);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshMembershipOnReturn();
    });

    updateAccessUI();
}

let lastWidth = null;
function adjustMobileLayout() {
    const currentWidth = window.innerWidth;
    if (lastWidth !== null && currentWidth === lastWidth) return;
    lastWidth = currentWidth;

    const isMobile = currentWidth <= MOBILE_BREAKPOINT;
    const header = document.querySelector(".header");
    const panelHeader = header ? header.parentNode : null;
    const panelLeft = document.querySelector(".panel-left");
    const panelRight = document.querySelector(".panel-right");
    const dropZoneEl = document.getElementById("dropZone");
    if (isMobile) {
        if (dropZoneEl && panelHeader && dropZoneEl.parentNode !== panelHeader) {
            panelHeader.after(dropZoneEl);
        }
    } else {
        if (dropZoneEl && panelRight && dropZoneEl.parentNode !== panelRight) {
            panelRight.insertBefore(dropZoneEl, panelRight.firstChild);
        }
    }
}

function setActiveNavigation(view) {
    document.querySelectorAll(".app-nav-button").forEach((button) => {
        const isActive = button.dataset.view === view;
        button.classList.toggle("active", isActive);
        if (isActive) {
            button.setAttribute("aria-current", "page");
        } else {
            button.removeAttribute("aria-current");
        }
    });
}

function focusNavigationSection(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.remove("nav-highlight");
    requestAnimationFrame(() => {
        element.classList.add("nav-highlight");
        window.setTimeout(() => element.classList.remove("nav-highlight"), 950);
    });
}

function setHistorySectionVisible(visible) {
    if (!historySection) return;
    historySection.hidden = !visible;
    historySection.setAttribute("aria-hidden", String(!visible));
    if (!visible) {
        historySection.classList.remove("nav-highlight");
    }
}

function setVideoCheckStatus(message, state = "idle") {
    if (!videoCheckStatus) return;
    videoCheckStatus.textContent = message;
    videoCheckStatus.dataset.state = state;
}

function formatCheckedDuration(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "Unavailable";

    const rounded = Math.round(totalSeconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const remainingSeconds = rounded % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatCheckedBitrate(bitsPerSecond) {
    const bitrate = Number(bitsPerSecond);
    if (!Number.isFinite(bitrate) || bitrate <= 0) return "Unavailable";
    if (bitrate >= 1_000_000) return `${(bitrate / 1_000_000).toFixed(2)} Mbps`;
    return `${Math.round(bitrate / 1000)} kbps`;
}

function formatCheckedFps(fps) {
    const value = Number(fps);
    if (!Number.isFinite(value) || value <= 0) return "Unavailable";
    const rounded = Math.abs(value - Math.round(value)) < 0.05
        ? Math.round(value)
        : value.toFixed(2);
    return `${rounded} FPS`;
}

function formatCheckedResolution(resolution) {
    const width = Number(resolution?.width);
    const height = Number(resolution?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return "Unavailable";
    }
    return `${Math.round(width)} × ${Math.round(height)}`;
}

function resetTikTokVideoResult() {
    if (videoCheckResult) videoCheckResult.hidden = true;
    const thumbnail = document.getElementById("videoCheckThumbnail");
    const fallback = document.getElementById("videoCheckThumbnailFallback");
    const fpsSource = document.getElementById("videoCheckFpsSource");
    if (fpsSource) {
        fpsSource.textContent = "";
        fpsSource.hidden = true;
    }
    if (thumbnail) {
        thumbnail.hidden = true;
        thumbnail.removeAttribute("src");
    }
    if (fallback) fallback.hidden = false;
}

function renderTikTokVideoResult(payload) {
    const video = payload?.video || {};
    const thumbnail = document.getElementById("videoCheckThumbnail");
    const fallback = document.getElementById("videoCheckThumbnailFallback");
    const originalLink = document.getElementById("videoCheckOriginalLink");

    setElementText("videoCheckVideoTitle", video.title || "TikTok video");
    setElementText(
        "videoCheckVideoAuthor",
        video.author ? `@${String(video.author).replace(/^@/, "")}` : "TikTok creator",
    );
    setElementText("videoCheckResolution", formatCheckedResolution(video.resolution));
    setElementText("videoCheckBitrate", formatCheckedBitrate(video.bitrate));
    setElementText("videoCheckFps", formatCheckedFps(video.fps));
    const fpsSource = document.getElementById("videoCheckFpsSource");
    if (fpsSource) {
        if (video.fpsSource === "mp4" && video.fps) {
            fpsSource.textContent = "Detected from video";
            fpsSource.hidden = false;
        } else if (video.fpsSource === "tiktok_metadata" && video.fps) {
            fpsSource.textContent = "TikTok metadata";
            fpsSource.hidden = false;
        } else if (video.fpsSource === "bitrate_estimate" && video.fps) {
            fpsSource.textContent = "Estimated from bitrate";
            fpsSource.hidden = false;
        } else {
            fpsSource.textContent = "";
            fpsSource.hidden = true;
        }
    }
    setElementText("videoCheckDuration", formatCheckedDuration(video.duration));
    setElementText(
        "videoCheckFileSize",
        Number(video.fileSize) > 0 ? formatFileSize(Number(video.fileSize)) : "Unavailable",
    );

    const note = document.querySelector("#videoCheckNote span");
    if (note) {
        note.textContent = payload?.note || "Metadata is checked without saving the TikTok video.";
    }

    if (originalLink) {
        originalLink.href = video.url || "https://www.tiktok.com/";
    }

    if (thumbnail && video.thumbnail) {
        thumbnail.onload = () => {
            thumbnail.hidden = false;
            if (fallback) fallback.hidden = true;
        };
        thumbnail.onerror = () => {
            thumbnail.hidden = true;
            if (fallback) fallback.hidden = false;
        };
        thumbnail.src = video.thumbnail;
    } else {
        if (thumbnail) thumbnail.hidden = true;
        if (fallback) fallback.hidden = false;
    }

    if (videoCheckResult) videoCheckResult.hidden = false;
}

function normalizeClientTikTokUrl(value) {
    let url = String(value || "").trim();
    if (!url) throw new Error("Paste a TikTok video link first.");
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("This TikTok link is not valid.");
    }

    const host = parsed.hostname.toLowerCase();
    if (host !== "tiktok.com" && !host.endsWith(".tiktok.com")) {
        throw new Error("Please use a link from TikTok.");
    }

    return parsed.toString();
}

function initializeTikTokVideoChecker() {
    if (!videoCheckForm || !videoCheckUrl || !videoCheckSubmitBtn) return;

    videoCheckPasteBtn?.addEventListener("click", async () => {
        try {
            const value = await navigator.clipboard.readText();
            if (!value) {
                setVideoCheckStatus("Clipboard is empty.", "error");
                return;
            }
            videoCheckUrl.value = value.trim();
            videoCheckUrl.focus();
            setVideoCheckStatus("TikTok link pasted. Press Check Video.", "ready");
        } catch {
            setVideoCheckStatus("Browser blocked clipboard access. Paste the link manually.", "error");
            videoCheckUrl.focus();
        }
    });

    videoCheckForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!requireLogin()) return;

        let url;
        try {
            url = normalizeClientTikTokUrl(videoCheckUrl.value);
        } catch (error) {
            resetTikTokVideoResult();
            setVideoCheckStatus(error.message, "error");
            return;
        }

        const originalMarkup = videoCheckSubmitBtn.innerHTML;
        videoCheckSubmitBtn.disabled = true;
        videoCheckSubmitBtn.setAttribute("aria-busy", "true");
        videoCheckSubmitBtn.innerHTML =
            '<i class="ri-loader-4-line video-check-spinner" aria-hidden="true"></i><span>Checking...</span>';
        resetTikTokVideoResult();
        setVideoCheckStatus(
            "Checking TikTok video metadata. This can take a few seconds...",
            "loading",
        );

        try {
            const response = await fetch("/api/tiktok/check", {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({ url }),
            });

            const rawBody = await response.text();
            let data = {};
            try {
                data = rawBody ? JSON.parse(rawBody) : {};
            } catch {
                throw new Error("The server returned an invalid TikTok check response.");
            }

            if (!response.ok || !data.ok) {
                const code = data.code ? ` (${data.code})` : "";
                throw new Error(`${data.error || "Unable to inspect this TikTok video."}${code}`);
            }

            renderTikTokVideoResult(data);
            const missing = Object.entries(data.availability || {})
                .filter(([, available]) => !available)
                .map(([name]) => name);

            if (missing.length > 0) {
                setVideoCheckStatus(
                    `Video checked. TikTok did not expose: ${missing.join(", ")}.`,
                    "warning",
                );
            } else {
                setVideoCheckStatus("Video metadata checked successfully.", "success");
            }
        } catch (error) {
            resetTikTokVideoResult();
            setVideoCheckStatus(error.message, "error");
        } finally {
            videoCheckSubmitBtn.disabled = false;
            videoCheckSubmitBtn.removeAttribute("aria-busy");
            videoCheckSubmitBtn.innerHTML = originalMarkup;
        }
    });
}

function setPrimaryAppView(view) {
    const historyOnly = view === "history";
    const checkOnly = view === "check";
    const compressorOnly = !historyOnly && !checkOnly;

    // History and Check are dedicated views. Compressor controls are restored
    // only when the Compress navigation item is selected.
    if (dropZone) {
        dropZone.hidden = !compressorOnly;
        dropZone.setAttribute("aria-hidden", String(!compressorOnly));
    }
    if (queueAndActionsWrapper) {
        queueAndActionsWrapper.hidden = !compressorOnly;
        queueAndActionsWrapper.setAttribute("aria-hidden", String(!compressorOnly));
    }
    if (systemStatusPanel) {
        systemStatusPanel.hidden = !compressorOnly;
        systemStatusPanel.setAttribute("aria-hidden", String(!compressorOnly));
    }

    setHistorySectionVisible(historyOnly);

    if (videoCheckSection) {
        videoCheckSection.hidden = !checkOnly;
        videoCheckSection.setAttribute("aria-hidden", String(!checkOnly));
    }

    document.body.dataset.appView = checkOnly
        ? "check"
        : historyOnly
          ? "history"
          : "compress";
}

function initializeBottomNavigation() {
    const compressButton = document.getElementById("navCompressBtn");
    const historyButton = document.getElementById("navHistoryBtn");
    const checkButton = document.getElementById("navCheckBtn");
    const tutorialButton = document.getElementById("navTutorialBtn");
    const profileButton = document.getElementById("navProfileBtn");
    const profileModal = document.getElementById("profileModal");

    compressButton?.addEventListener("click", () => {
        if (!requireLogin()) return;
        setPrimaryAppView("compress");
        setActiveNavigation("compress");
        focusNavigationSection(dropZone);
    });

    historyButton?.addEventListener("click", async () => {
        if (!requireLogin()) return;
        await renderHistoryList();
        setPrimaryAppView("history");
        const historyContainer = historyHeader?.parentElement;
        historyContainer?.classList.remove("collapsed");
        document.getElementById("historyToggleBtn")?.setAttribute("aria-expanded", "true");
        setActiveNavigation("history");
        focusNavigationSection(historyContainer);
    });

    checkButton?.addEventListener("click", () => {
        if (!requireLogin()) return;
        setPrimaryAppView("check");
        setActiveNavigation("check");
        focusNavigationSection(videoCheckSection);
        window.setTimeout(() => videoCheckUrl?.focus({ preventScroll: true }), 250);
    });

    tutorialButton?.addEventListener("click", () => {
        setActiveNavigation("tutorial");
        openModal("tutorialModal");
        const firstTutorialVideo = document.querySelector("#tutorialModal .tutorial-video");
        window.setTimeout(() => firstTutorialVideo?.focus({ preventScroll: true }), 120);
    });

    profileButton?.addEventListener("click", () => {
        updateAccessUI();
        setActiveNavigation("profile");
        openModal("profileModal");
    });

    document.getElementById("profileLoginBtn")?.addEventListener("click", () => {
        closeModal("profileModal");
        openModal("telegramModal");
    });

    const openProfilePlans = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        setActiveNavigation("profile");
        const panel = document.getElementById("subscriptionPanel");
        const body = document.querySelector("#profileModal .profile-modal-body");
        if (!panel) return;

        // Force visibility even if a stale stylesheet or cached [hidden] rule is active.
        panel.hidden = false;
        panel.removeAttribute("hidden");
        panel.setAttribute("aria-hidden", "false");
        panel.style.display = "block";
        panel.classList.add("plans-reveal");

        window.setTimeout(() => {
            if (body) {
                body.scrollTo({ top: panel.offsetTop - 12, behavior: "smooth" });
            } else {
                panel.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        }, 80);
    };

    // Direct listeners plus delegated fallback for mobile browsers/cached DOM.
    document.getElementById("profilePlansBtn")?.addEventListener("click", openProfilePlans);
    document.getElementById("profilePlansInlineBtn")?.addEventListener("click", openProfilePlans);
    document.addEventListener("click", (event) => {
        const trigger = event.target.closest?.("#profilePlansBtn, #profilePlansInlineBtn");
        if (trigger) openProfilePlans(event);
    });

    window.openSubscriptionPlans = openProfilePlans;

    document.getElementById("profileLogoutBtn")?.addEventListener("click", () => {
        closeModal("profileModal");
        document.getElementById("logoutBtn")?.click();
        setPrimaryAppView("compress");
        setActiveNavigation("compress");
    });

    profileModal?.addEventListener("click", (event) => {
        if (event.target === profileModal) {
            closeModal("profileModal");
        }
    });

    const tutorialModal = document.getElementById("tutorialModal");
    const tutorialVideos = [...document.querySelectorAll("#tutorialModal .tutorial-video")];

    document.querySelectorAll("#tutorialModal .tutorial-video-shell").forEach((shell) => {
        const cover = shell.querySelector(".tutorial-cover");
        const video = shell.querySelector(".tutorial-video");
        if (!cover || !video) return;

        cover.addEventListener("click", async () => {
            tutorialVideos.forEach((otherVideo) => {
                if (otherVideo !== video) {
                    otherVideo.pause();
                    otherVideo.closest(".tutorial-video-shell")?.classList.remove("is-playing");
                }
            });
            shell.classList.add("is-playing");
            try {
                await video.play();
            } catch (error) {
                shell.classList.remove("is-playing");
                console.warn("Tutorial video could not start:", error);
            }
        });

        video.addEventListener("ended", () => {
            shell.classList.remove("is-playing");
            video.currentTime = 0;
        });
    });

    const closeTutorial = () => {
        tutorialVideos.forEach((video) => {
            video.pause();
            video.currentTime = 0;
            video.closest(".tutorial-video-shell")?.classList.remove("is-playing");
        });
        closeModal("tutorialModal");
        setActiveNavigation(document.body.dataset.appView || "compress");
    };

    document.getElementById("tutorialCloseBtn")?.addEventListener("click", closeTutorial);
    tutorialModal?.addEventListener("click", (event) => {
        if (event.target === tutorialModal) closeTutorial();
    });

    setPrimaryAppView("compress");
    setActiveNavigation("compress");
}

function initializeApp() {
    initializeMembership();
    autoConnectTelegramAdminBot();
    renderHistoryList();
    initializeTikTokVideoChecker();
    initializeTikTokPosting();
    initializeBottomNavigation();
    adjustMobileLayout();
    window.addEventListener("resize", adjustMobileLayout);

    const copyBtn = document.getElementById("copyLogBtn");
    const copyToast = document.getElementById("copyLogToast");
    if (copyBtn) {
        let toastTimer = null;
        copyBtn.addEventListener("click", async () => {
            const text = [...statusLog.querySelectorAll(".log-row")]
                .map((r) => r.textContent)
                .join("\n");
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                if (copyToast) {
                    copyToast.textContent = "Copied";
                    copyToast.classList.add("show");
                    clearTimeout(toastTimer);
                    toastTimer = setTimeout(() => {
                        copyToast.classList.remove("show");
                    }, 1500);
                }
            } catch {
                if (copyToast) {
                    copyToast.textContent = "Copy failed";
                    copyToast.classList.add("show");
                    clearTimeout(toastTimer);
                    toastTimer = setTimeout(() => {
                        copyToast.classList.remove("show");
                    }, 1500);
                }
            }
        });
    }
}

function logMessage(text, type = "info") {
    const row = document.createElement("div");
    row.className = `log-row log-${type}`;
    row.textContent = text;
    statusLog.appendChild(row);
    statusLog.scrollTop = statusLog.scrollHeight;
}

function clearLog() {
    statusLog.innerHTML = "";
}

function setLogCopyVisible(visible) {
    const copyBtn = document.getElementById("copyLogBtn");
    if (copyBtn) copyBtn.classList.toggle("visible", visible);
}

function setProgress(percent) {
    progressBar.style.width = `${percent}%`;
}

function showProgress() {
    progressTrack.classList.add("active");
    progressTrack.style.opacity = "1";
}

function hideProgress() {
    setTimeout(() => {
        progressTrack.style.opacity = "0";
        setTimeout(() => {
            setProgress(0);
            progressTrack.classList.remove("active");
        }, PROGRESS_FADE_DURATION_MS);
    }, PROGRESS_HIDE_DELAY_MS);
}

function isSupportedFile(file) {
    const lowerName = file.name.toLowerCase();
    return (
        supportedMimeTypes.includes(file.type) ||
        supportedExtensions.some((ext) => lowerName.endsWith(ext))
    );
}

function getMimeType(file) {
    return "video/mp4";
}

function isMovFile(file) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".mov")) return true;
    if (file.type === "video/quicktime" || file.type === "video/x-quicktime")
        return true;
    return false;
}

function getOutputFilename() {
    const randomNumber = crypto.getRandomValues(new Uint32Array(1))[0]
        .toString()
        .padStart(10, "0")
        .slice(0, 10);
    return `@theziess.method_${randomNumber}.mp4`;
}

function captureVideoFrame(file) {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        let settled = false;
        let objectUrl = null;

        function cleanup(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.src = "";
            video.load();
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
            resolve(result);
        }

        // Set event handlers BEFORE assigning src to prevent race condition
        video.onloadeddata = () => {
            if (settled) return;
            video.currentTime = 0.1;
        };

        video.onseeked = () => {
            if (settled) return;
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const maxDimension = MAX_THUMBNAIL_DIMENSION;
            let width = video.videoWidth;
            let height = video.videoHeight;

            if (width > height) {
                if (width > maxDimension) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                }
            } else {
                if (height > maxDimension) {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(video, 0, 0, width, height);

            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            cleanup(dataUrl);
        };

        video.onerror = () => {
            cleanup(null);
        };

        // Assign src AFTER handlers are set
        objectUrl = URL.createObjectURL(file);
        const timeoutId = setTimeout(() => {
            cleanup(null);
        }, FRAME_CAPTURE_TIMEOUT_MS);

        video.src = objectUrl;
    });
}

function formatFileSize(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function downloadBuffer(data, filename, mimeType) {
    const blob =
        data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
        document.body.removeChild(anchor);
    }, DOWNLOAD_ANCHOR_CLEANUP_MS);
    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, DOWNLOAD_REVOKE_DELAY_MS);
}


function formatDurationSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "Unavailable";
    const rounded = Math.round(seconds);
    const minutes = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function updateTikTokAccountUI() {
    const account = currentTikTokAccount;
    const connected = Boolean(account?.connected);
    const expired = account?.status === "expired";
    const loading = account?.status === "loading";
    const unavailable = account?.status === "unavailable";
    const avatar = document.getElementById("tiktokAccountAvatar");
    const name = document.getElementById("tiktokAccountName");
    const status = document.getElementById("tiktokAccountStatus");
    const scopes = document.getElementById("tiktokGrantedScopes");
    const connectButton = document.getElementById("connectTikTokBtn");
    const disconnectButton = document.getElementById("disconnectTikTokBtn");

    if (name) {
        name.textContent = connected || expired
            ? account.displayName || "TikTok User"
            : loading
              ? "កំពុងពិនិត្យ TikTok…"
              : "មិនទាន់ភ្ជាប់ TikTok";
    }
    if (status) {
        status.textContent = connected
            ? "បានភ្ជាប់ · អាចផ្ញើទៅ Inbox/Draft"
            : expired
              ? "Connection expired · សូមភ្ជាប់ម្ដងទៀត"
              : loading
                ? "កំពុងផ្ទុកស្ថានភាពគណនី / Loading account status"
                : unavailable
                  ? "មិនអាចពិនិត្យ TikTok បាន · សូមសាកម្ដងទៀត"
                  : currentUser
                    ? "ភ្ជាប់ TikTok ដើម្បីផ្ញើវីដេអូ Draft"
                    : "សូម Login ជាមួយ Telegram ជាមុន";
        status.classList.toggle("expired", expired || unavailable);
    }
    if (scopes) {
        scopes.textContent = connected
            ? (account.scopes || []).join(" · ")
            : "user.info.basic · video.upload";
    }
    if (avatar) {
        const avatarUrl = String(account?.avatarUrl || "");
        avatar.hidden = !avatarUrl;
        if (avatarUrl) avatar.src = avatarUrl;
        else avatar.removeAttribute("src");
    }
    if (connectButton) {
        connectButton.hidden = connected;
        connectButton.disabled = !currentUser || loading;
        const label = connectButton.querySelector("span");
        if (label) {
            label.textContent = loading
                ? "កំពុងពិនិត្យ…"
                : expired || unavailable
                  ? "ភ្ជាប់ TikTok ម្ដងទៀត"
                  : "ភ្ជាប់ TikTok / Connect";
        }
    }
    if (disconnectButton) {
        disconnectButton.hidden = loading || (!connected && !expired);
        disconnectButton.disabled = loading;
    }
}

async function loadTikTokAccount() {
    if (!currentUser) {
        currentTikTokAccount = null;
        updateTikTokAccountUI();
        return null;
    }
    currentTikTokAccount = { connected: false, status: "loading" };
    updateTikTokAccountUI();
    try {
        const response = await fetch(`/api/tiktok/account?t=${Date.now()}`, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Unable to read TikTok account.");
        currentTikTokAccount = data.account || null;
    } catch (error) {
        console.warn("TikTok account status unavailable", error);
        currentTikTokAccount = { connected: false, status: "unavailable" };
    }
    updateTikTokAccountUI();
    return currentTikTokAccount;
}

function cleanupTikTokUploadPreview() {
    const preview = document.getElementById("tiktokUploadPreview");
    if (preview) {
        preview.pause();
        preview.removeAttribute("src");
        preview.load();
    }
    if (tiktokUploadPreviewUrl) {
        URL.revokeObjectURL(tiktokUploadPreviewUrl);
        tiktokUploadPreviewUrl = null;
    }
}

function setTikTokUploadProgress({ percent = 0, uploaded = 0, total = 0, stage = "Ready" } = {}) {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = document.getElementById("tiktokUploadProgressBar");
    if (bar) bar.style.width = `${safePercent}%`;
    setElementText("tiktokUploadPercent", `${Math.round(safePercent)}%`);
    setElementText("tiktokUploadBytes", `${formatFileSize(uploaded)} / ${formatFileSize(total)}`);
    setElementText("tiktokUploadStage", stage);
}

function setTikTokUploadError(message = "") {
    const errorElement = document.getElementById("tiktokUploadError");
    if (!errorElement) return;
    errorElement.hidden = !message;
    errorElement.textContent = message;
}

function buildTikTokCandidate({ blob, filename, metadata, source = "processed" }) {
    if (!(blob instanceof Blob)) throw new Error("TikTok upload artifact is missing.");
    const cleanMetadata = {
        ...metadata,
        byteSize: blob.size,
        mimeType: blob.type || metadata?.mimeType || "video/mp4",
    };
    const validation = validateTikTokArtifact(cleanMetadata);
    if (!validation.valid) {
        throw new Error(validation.errors.map((item) => item.message).join(" "));
    }
    return {
        blob,
        filename: String(filename || "theziess-tiktok-upload.mp4"),
        metadata: cleanMetadata,
        source,
    };
}

async function openTikTokUploadReview(candidateInput) {
    if (!requireLogin()) return;
    if (!currentTikTokAccount?.connected) {
        await loadTikTokAccount();
    }
    if (!currentTikTokAccount?.connected) {
        openModal("profileModal");
        document.getElementById("connectTikTokBtn")?.focus();
        logMessage("Connect TikTok before uploading a draft.", "warning");
        return;
    }

    if (pendingTikTokStatusCheck && pendingTikTokUpload) {
        if (!tiktokUploadPreviewUrl) {
            tiktokUploadPreviewUrl = URL.createObjectURL(pendingTikTokUpload.blob);
            const existingPreview = document.getElementById("tiktokUploadPreview");
            if (existingPreview) existingPreview.src = tiktokUploadPreviewUrl;
        }
        const retry = document.getElementById("tiktokUploadRetryBtn");
        if (retry) {
            retry.textContent = "ពិនិត្យ Status ម្ដងទៀត / Check Again";
            retry.removeAttribute("hidden");
        }
        setTikTokUploadError("TikTok is still processing the current upload. Check its status before starting another.");
        openModal("tiktokUploadModal");
        lockScroll();
        return;
    }

    let candidate;
    try {
        candidate = buildTikTokCandidate(candidateInput);
    } catch (error) {
        logMessage(`TikTok upload blocked: ${error.message}`, "error");
        return;
    }

    pendingTikTokUpload = candidate;
    pendingTikTokStatusCheck = null;
    cleanupTikTokUploadPreview();
    tiktokUploadPreviewUrl = URL.createObjectURL(candidate.blob);
    const preview = document.getElementById("tiktokUploadPreview");
    if (preview) preview.src = tiktokUploadPreviewUrl;

    setElementText("tiktokUploadFilename", candidate.filename);
    setElementText("tiktokUploadSize", formatFileSize(candidate.blob.size));
    setElementText("tiktokUploadResolution", `${candidate.metadata.width}×${candidate.metadata.height}`);
    setElementText("tiktokUploadDuration", formatDurationSeconds(candidate.metadata.duration));
    setElementText("tiktokUploadFps", `${formatRealFps(candidate.metadata.fps)} FPS`);
    setElementText("tiktokUploadAccountName", currentTikTokAccount.displayName || "TikTok User");

    const accountAvatar = document.getElementById("tiktokUploadAccountAvatar");
    if (accountAvatar) {
        const url = String(currentTikTokAccount.avatarUrl || "");
        accountAvatar.hidden = !url;
        if (url) accountAvatar.src = url;
        else accountAvatar.removeAttribute("src");
    }

    const consent = document.getElementById("tiktokUploadConsent");
    if (consent) consent.checked = false;
    const confirm = document.getElementById("tiktokUploadConfirmBtn");
    if (confirm) confirm.disabled = true;
    document.getElementById("tiktokUploadProgress")?.setAttribute("hidden", "");
    document.getElementById("tiktokUploadSuccess")?.setAttribute("hidden", "");
    const retryButton = document.getElementById("tiktokUploadRetryBtn");
    retryButton?.setAttribute("hidden", "");
    if (retryButton) retryButton.textContent = "សាកម្ដងទៀត / Retry";
    setTikTokUploadError("");
    setTikTokUploadProgress({ total: candidate.blob.size, stage: "Ready for consent" });
    openModal("tiktokUploadModal");
    lockScroll();
}

function xhrPutChunk({ uploadUrl, chunkBlob, contentRange, mimeType, signal, onProgress }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl, true);
        xhr.setRequestHeader("Content-Type", mimeType);
        xhr.setRequestHeader("Content-Range", contentRange);
        // Browsers set the exact Content-Length automatically from chunkBlob.
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress?.(event.loaded, event.total);
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`TikTok upload failed (${xhr.status}).`));
        };
        xhr.onerror = () => reject(new Error("Network error while uploading to TikTok."));
        xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

        const abort = () => xhr.abort();
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        xhr.onloadend = () => signal?.removeEventListener("abort", abort);
        xhr.send(chunkBlob);
    });
}

function waitWithSignal(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(new DOMException("Upload cancelled", "AbortError"));
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
    });
}

async function cancelTikTokUploadRecord(publishId) {
    if (!publishId) return;
    try {
        await fetch("/api/tiktok/upload/cancel", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            keepalive: true,
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ publishId }),
        });
    } catch {
        // Cancellation is best effort and must not freeze the interface.
    }
}

async function pollTikTokUploadStatus(publishId, totalBytes, signal) {
    const delays = [1000, 1500, 2500, 4000, 6500, 10_000, 10_000, 10_000, 10_000, 10_000];
    for (const delay of delays) {
        await waitWithSignal(delay, signal);
        const response = await fetch("/api/tiktok/upload/status", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ publishId }),
            signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Unable to read TikTok upload status.");
        const uploadedBytes = Math.min(totalBytes, Number(data.uploadedBytes || totalBytes));
        setTikTokUploadProgress({
            percent: 100,
            uploaded: uploadedBytes,
            total: totalBytes,
            stage: data.message || data.stage,
        });
        if (data.terminal) return data;
    }
    return { terminal: false, success: false, status: "PROCESSING_UPLOAD" };
}

function showTikTokUploadSuccess(candidate) {
    const successPanel = document.getElementById("tiktokUploadSuccess");
    successPanel?.removeAttribute("hidden");
    setElementText(
        "tiktokUploadSuccessMessage",
        "Upload complete. Open the TikTok app, check your Inbox notification, review the video and finish posting it.",
    );
    setTikTokUploadProgress({
        percent: 100,
        uploaded: candidate.blob.size,
        total: candidate.blob.size,
        stage: "Draft delivered to TikTok Inbox",
    });
    logMessage("TikTok draft upload complete. Finish posting inside the TikTok app.", "success");
    pendingTikTokStatusCheck = null;
    cleanupTikTokUploadPreview();
    pendingTikTokUpload = null;
}

async function checkPendingTikTokUploadStatus() {
    if (!pendingTikTokStatusCheck || !pendingTikTokUpload || activeTikTokUploadPromise) return;
    const candidate = pendingTikTokUpload;
    const pending = pendingTikTokStatusCheck;
    const controller = new AbortController();
    activeTikTokUploadController = controller;
    const retry = document.getElementById("tiktokUploadRetryBtn");
    const cancel = document.getElementById("tiktokUploadCancelBtn");
    const close = document.getElementById("tiktokUploadCloseBtn");
    retry?.setAttribute("hidden", "");
    if (cancel) cancel.textContent = "Stop Checking";
    if (close) close.disabled = true;
    setTikTokUploadError("");

    activeTikTokUploadPromise = pollTikTokUploadStatus(
        pending.publishId,
        pending.totalBytes,
        controller.signal,
    );
    try {
        const result = await activeTikTokUploadPromise;
        if (result.terminal && result.success) {
            showTikTokUploadSuccess(candidate);
        } else if (result.terminal) {
            pendingTikTokStatusCheck = null;
            throw new Error(
                result.failReason
                    ? `TikTok processing failed: ${result.failReason}`
                    : "TikTok processing failed.",
            );
        } else {
            setTikTokUploadProgress({
                percent: 100,
                uploaded: candidate.blob.size,
                total: candidate.blob.size,
                stage: "TikTok is still processing. Check again shortly.",
            });
            if (retry) {
                retry.textContent = "ពិនិត្យ Status ម្ដងទៀត / Check Again";
                retry.removeAttribute("hidden");
            }
        }
    } catch (error) {
        if (error?.name === "AbortError") {
            setTikTokUploadError("Status checking paused. TikTok may continue processing the uploaded video.");
        } else {
            setTikTokUploadError(error.message || "Unable to check TikTok processing status.");
        }
        if (pendingTikTokStatusCheck && retry) {
            retry.textContent = "ពិនិត្យ Status ម្ដងទៀត / Check Again";
            retry.removeAttribute("hidden");
        }
    } finally {
        activeTikTokUploadController = null;
        activeTikTokUploadPromise = null;
        if (cancel) cancel.textContent = "បោះបង់ / Cancel";
        if (close) close.disabled = false;
    }
}

async function performTikTokUpload() {
    if (!pendingTikTokUpload || activeTikTokUploadPromise) return;
    const candidate = pendingTikTokUpload;
    let uploadReachedTerminalStatus = false;
    let binaryTransferComplete = false;
    const controller = new AbortController();
    activeTikTokUploadController = controller;

    const confirm = document.getElementById("tiktokUploadConfirmBtn");
    const cancel = document.getElementById("tiktokUploadCancelBtn");
    const close = document.getElementById("tiktokUploadCloseBtn");
    const progressPanel = document.getElementById("tiktokUploadProgress");
    const retry = document.getElementById("tiktokUploadRetryBtn");
    const successPanel = document.getElementById("tiktokUploadSuccess");

    if (confirm) confirm.disabled = true;
    if (cancel) cancel.textContent = "Cancel Upload";
    if (close) close.disabled = true;
    progressPanel?.removeAttribute("hidden");
    successPanel?.setAttribute("hidden", "");
    retry?.setAttribute("hidden", "");
    setTikTokUploadError("");

    activeTikTokUploadPromise = (async () => {
        setTikTokUploadProgress({ total: candidate.blob.size, stage: "Creating secure TikTok upload session…" });
        const initResponse = await fetch("/api/tiktok/upload/init", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
                filename: candidate.filename,
                fileSize: candidate.blob.size,
                mimeType: candidate.blob.type || "video/mp4",
            }),
            signal: controller.signal,
        });
        const initData = await initResponse.json().catch(() => ({}));
        if (!initResponse.ok || !initData.ok) throw new Error(initData.error || "TikTok upload initialization failed.");
        activeTikTokPublishId = initData.publishId;

        let uploadedBefore = 0;
        for (const chunk of initData.chunkPlan.chunks) {
            const chunkBlob = candidate.blob.slice(chunk.start, chunk.end + 1, candidate.blob.type);
            await xhrPutChunk({
                uploadUrl: initData.uploadUrl,
                chunkBlob,
                mimeType: candidate.blob.type || "video/mp4",
                contentRange: `bytes ${chunk.start}-${chunk.end}/${candidate.blob.size}`,
                signal: controller.signal,
                onProgress: (loaded) => {
                    const uploaded = Math.min(candidate.blob.size, uploadedBefore + loaded);
                    setTikTokUploadProgress({
                        percent: (uploaded / candidate.blob.size) * 100,
                        uploaded,
                        total: candidate.blob.size,
                        stage: `Uploading chunk ${chunk.index + 1}/${initData.chunkPlan.totalChunkCount}`,
                    });
                },
            });
            uploadedBefore += chunk.size;
        }
        binaryTransferComplete = true;
        if (cancel) cancel.textContent = "Stop Checking";

        setTikTokUploadProgress({
            percent: 100,
            uploaded: candidate.blob.size,
            total: candidate.blob.size,
            stage: "Upload sent. Waiting for TikTok processing…",
        });

        const result = await pollTikTokUploadStatus(initData.publishId, candidate.blob.size, controller.signal);
        uploadReachedTerminalStatus = Boolean(result.terminal);
        if (result.terminal && !result.success) {
            throw new Error(result.failReason ? `TikTok processing failed: ${result.failReason}` : "TikTok processing failed.");
        }

        if (result.success) {
            showTikTokUploadSuccess(candidate);
        } else {
            pendingTikTokStatusCheck = {
                publishId: initData.publishId,
                totalBytes: candidate.blob.size,
            };
            setTikTokUploadProgress({
                percent: 100,
                uploaded: candidate.blob.size,
                total: candidate.blob.size,
                stage: "TikTok is still processing. Check again shortly.",
            });
            if (retry) {
                retry.textContent = "ពិនិត្យ Status ម្ដងទៀត / Check Again";
                retry.removeAttribute("hidden");
            }
        }
    })();

    try {
        await activeTikTokUploadPromise;
    } catch (error) {
        if (activeTikTokPublishId && !uploadReachedTerminalStatus && !binaryTransferComplete) {
            await cancelTikTokUploadRecord(activeTikTokPublishId);
        }
        if (binaryTransferComplete && activeTikTokPublishId && !uploadReachedTerminalStatus) {
            pendingTikTokStatusCheck = {
                publishId: activeTikTokPublishId,
                totalBytes: candidate.blob.size,
            };
        }
        if (error?.name === "AbortError" && binaryTransferComplete) {
            setTikTokUploadError("Status checking paused. TikTok may continue processing the uploaded video.");
            setTikTokUploadProgress({
                percent: 100,
                uploaded: candidate.blob.size,
                total: candidate.blob.size,
                stage: "Status checking paused",
            });
            if (retry) {
                retry.textContent = "ពិនិត្យ Status ម្ដងទៀត / Check Again";
                retry.removeAttribute("hidden");
            }
        } else if (error?.name === "AbortError") {
            setTikTokUploadError("Upload cancelled. Select Upload to TikTok again when you are ready.");
            setTikTokUploadProgress({ total: candidate.blob.size, stage: "Cancelled" });
            cleanupTikTokUploadPreview();
            pendingTikTokUpload = null;
            pendingTikTokStatusCheck = null;
        } else {
            setTikTokUploadError(error.message || "TikTok upload failed.");
            if (pendingTikTokStatusCheck && retry) {
                retry.textContent = "ពិនិត្យ Status ម្ដងទៀត / Check Again";
            } else if (retry) {
                retry.textContent = "សាកម្ដងទៀត / Retry";
            }
            retry?.removeAttribute("hidden");
            logMessage(`TikTok upload failed: ${error.message}`, "error");
        }
    } finally {
        activeTikTokUploadController = null;
        activeTikTokUploadPromise = null;
        activeTikTokPublishId = null;
        if (cancel) cancel.textContent = "បោះបង់ / Cancel";
        if (close) close.disabled = false;
    }
}

function initializeTikTokPosting() {
    updateTikTokAccountUI();
    document.getElementById("connectTikTokBtn")?.addEventListener("click", () => {
        if (!requireLogin()) return;
        window.location.assign("/api/auth/tiktok");
    });
    document.getElementById("disconnectTikTokBtn")?.addEventListener("click", async () => {
        if (!currentUser) return;
        const button = document.getElementById("disconnectTikTokBtn");
        button.disabled = true;
        try {
            const response = await fetch("/api/tiktok/disconnect", {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({}),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) throw new Error(data.error || "Unable to disconnect TikTok.");
            currentTikTokAccount = null;
            updateTikTokAccountUI();
            logMessage("TikTok account disconnected.", "success");
        } catch (error) {
            logMessage(error.message || "Unable to disconnect TikTok.", "error");
        } finally {
            button.disabled = false;
        }
    });

    const consent = document.getElementById("tiktokUploadConsent");
    const confirm = document.getElementById("tiktokUploadConfirmBtn");
    consent?.addEventListener("change", () => {
        if (confirm) confirm.disabled = !consent.checked || Boolean(activeTikTokUploadPromise);
    });
    confirm?.addEventListener("click", performTikTokUpload);
    document.getElementById("tiktokUploadRetryBtn")?.addEventListener("click", () => {
        if (pendingTikTokStatusCheck) void checkPendingTikTokUploadStatus();
        else void performTikTokUpload();
    });
    document.getElementById("tiktokUploadCancelBtn")?.addEventListener("click", () => {
        if (activeTikTokUploadController) {
            activeTikTokUploadController.abort();
            return;
        }
        closeModal("tiktokUploadModal");
        unlockScroll();
        cleanupTikTokUploadPreview();
    });
    document.getElementById("tiktokUploadCloseBtn")?.addEventListener("click", () => {
        if (activeTikTokUploadPromise) return;
        closeModal("tiktokUploadModal");
        unlockScroll();
        cleanupTikTokUploadPreview();
    });
    document.getElementById("tiktokUploadModal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget && !activeTikTokUploadPromise) {
            closeModal("tiktokUploadModal");
            unlockScroll();
            cleanupTikTokUploadPreview();
        }
    });
}

function getStatusLabel(status) {
    return (
        {
            pending: "Pending",
            processing: "Processing",
            success: "Done",
            error: "Error",
        }[status] || status
    );
}

function renderFileList() {
    fileListEl.innerHTML = "";

    if (selectedFiles.length === 0) {
        fileListEl.style.display = "none";
        clearBtn.style.display = "none";
        return;
    }

    fileListEl.style.display = "flex";
    clearBtn.style.display = "inline-flex";

    let index = 0;
    for (const item of selectedFiles) {
        const removeIndex = index;
        const row = document.createElement("div");
        row.className = `file-item status-${item.status}`;

        const checkboxWrapper = document.createElement("label");
        checkboxWrapper.className = "custom-checkbox";
        const checkboxInput = document.createElement("input");
        checkboxInput.type = "checkbox";
        checkboxInput.checked = item.checked;
        if (
            currentFlowState !== "completed" ||
            item.status !== "success" ||
            !item.patchedBuffer
        ) {
            checkboxInput.disabled = true;
        }
        checkboxInput.addEventListener("change", () => {
            item.checked = checkboxInput.checked;
            updatePatchButton();
        });
        const checkboxSpan = document.createElement("span");
        checkboxSpan.className = "checkbox-mark";
        checkboxWrapper.appendChild(checkboxInput);
        checkboxWrapper.appendChild(checkboxSpan);
        row.appendChild(checkboxWrapper);

        const body = document.createElement("div");
        body.className = "file-item-body";

        const name = document.createElement("div");
        name.className = "file-item-name";
        name.textContent = item.name;

        const meta = document.createElement("div");
        meta.className = "file-item-meta";
        meta.textContent = formatFileSize(item.size);

        const fileProgressTrack = document.createElement("div");
        fileProgressTrack.className = "file-item-progress";
        const fileProgressBar = document.createElement("div");
        fileProgressBar.className = "file-item-progress-bar";
        fileProgressTrack.appendChild(fileProgressBar);

        body.appendChild(name);
        body.appendChild(meta);
        body.appendChild(fileProgressTrack);

        const icon = document.createElement("div");
        icon.className = "file-item-icon";
        const iconEl = document.createElement("i");
        iconEl.className = "ri-movie-2-fill";
        icon.appendChild(iconEl);

        row.appendChild(icon);
        row.appendChild(body);

        const right = document.createElement("div");
        right.className = "file-item-right";

        const badge = document.createElement("span");
        badge.className = `file-badge badge-${item.status}`;
        badge.textContent = getStatusLabel(item.status);
        right.appendChild(badge);

        if (item.status === "success" && item.tiktokUploadBlob) {
            const uploadButton = document.createElement("button");
            uploadButton.type = "button";
            uploadButton.className = "file-tiktok-upload-btn";
            uploadButton.title = item.tiktokUploadValidation?.valid
                ? "Upload clean video to TikTok Inbox/Draft"
                : "This video is not compatible with TikTok upload requirements";
            uploadButton.disabled = !item.tiktokUploadValidation?.valid;
            const uploadIcon = document.createElement("i");
            uploadIcon.className = "ri-tiktok-fill";
            const uploadLabel = document.createElement("span");
            uploadLabel.textContent = "Upload";
            uploadButton.append(uploadIcon, uploadLabel);
            uploadButton.addEventListener("click", () => {
                void openTikTokUploadReview({
                    blob: item.tiktokUploadBlob,
                    filename: item.outputName,
                    metadata: item.tiktokUploadMeta,
                    source: "processed",
                });
            });
            right.appendChild(uploadButton);
        }

        if (item.status === "pending" && currentFlowState !== "patching") {
            const removeBtn = document.createElement("button");
            removeBtn.className = "file-remove-btn";
            const removeIcon = document.createElement("i");
            removeIcon.className = "ri-close-fill";
            removeBtn.appendChild(removeIcon);
            removeBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                removeFile(removeIndex);
            });
            right.appendChild(removeBtn);
        }

        row.appendChild(right);
        fileListEl.appendChild(row);
        index++;
    }
    // Remix Icon CSS handles rendering
}

async function addFiles(fileList) {
    if (!requireLogin()) return;
    if (processingFiles || currentFlowState === "patching") return;
    processingFiles = true;
    try {
        const filesArray = Array.from(fileList);
        if (currentFlowState === "completed") {
            selectedFiles = [];
            currentFlowState = "idle";
            setLogCopyVisible(false);
        }
        let skipped = 0;
        for (const file of filesArray) {
            if (!isSupportedFile(file)) {
                skipped++;
                continue;
            }
            const isDupe = selectedFiles.some(
                (f) => f.name === file.name && f.size === file.size,
            );
            if (isDupe) {
                logMessage(
                    `Duplicate file detected: "${file.name}". Skipping.`,
                    "warning",
                );
                continue;
            }
            selectedFiles.push({
                file,
                name: file.name,
                size: file.size,
                status: "pending",
                patchedBuffer: null,
                tiktokUploadBlob: null,
                tiktokUploadMeta: null,
                tiktokUploadValidation: null,
                outputName: null,
                mimeType: null,
                checked: true,
            });
        }
        if (skipped > 0) logMessage(`${skipped} file(s) skipped.`, "warning");
        renderFileList();
        updatePatchButton();
        if (window.innerWidth <= MOBILE_BREAKPOINT) {
            setTimeout(() => {
                const controlBox = document.querySelector(".control-box");
                if (controlBox) {
                    controlBox.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                    });
                }
            }, MOBILE_SCROLL_DELAY_MS);
        }
    } finally {
        processingFiles = false;
    }
}

function removeFile(index) {
    if (currentFlowState === "patching") return;
    selectedFiles.splice(index, 1);
    if (selectedFiles.length === 0) {
        currentFlowState = "idle";
    }
    renderFileList();
    updatePatchButton();
}

function updatePatchButton() {
    const label = patchBtn.querySelector("span");
    const hint = document.getElementById("patchAccessHint");

    if (!LOCAL_STANDALONE_MODE && !currentUser) {
        patchBtn.disabled = true;
        patchBtn.dataset.accessState = "login-required";
        patchBtn.title = "Login with Telegram before compressing a video.";
        if (label) label.textContent = "Login Required";
        if (hint) {
            hint.hidden = false;
            hint.textContent = "Login with Telegram, then choose the FREE 3-day trial or a paid plan.";
            hint.dataset.action = "login";
            hint.setAttribute("aria-expanded", "false");
            hideSubscriptionPlans();
        }
        return;
    }

    if (!LOCAL_STANDALONE_MODE && !hasActiveSubscription()) {
        patchBtn.disabled = true;
        patchBtn.dataset.accessState = "subscription-required";
        patchBtn.title = "Activate FREE, PRO, PREMIUM, or MAX to unlock video compression.";
        if (label) label.textContent = "Subscription Required";
        if (hint) {
            hint.hidden = false;
            hint.textContent = "No active subscription. Click here to view FREE, PRO, PREMIUM, or MAX plans.";
            hint.dataset.action = "plans";
            const plansPanel = document.getElementById("subscriptionPanel");
            hint.setAttribute("aria-expanded", String(Boolean(plansPanel && !plansPanel.hidden)));
        }
        return;
    }

    patchBtn.dataset.accessState = "active";
    patchBtn.removeAttribute("title");
    if (hint) hint.hidden = true;
    const failedCount = selectedFiles.filter(
        (f) => f.status === "error",
    ).length;
    if (failedCount > 0) {
        patchBtn.disabled = false;
        const retryLabel =
            failedCount > 1 ? `Retry Failed (${failedCount})` : "Retry Failed";
        patchBtn.querySelector("span").textContent = retryLabel;
        return;
    }

    if (currentFlowState === "completed") {
        const currentVfi = !!enableInterpolation?.checked;
        const currentRes =
            document.getElementById("outputResolution")?.value || "1080";
        const settingsChanged =
            currentVfi !== lastPatchedVfi || currentRes !== lastPatchedRes;

        if (settingsChanged) {
            patchBtn.disabled = false;
            patchBtn.querySelector("span").textContent = "Repatch";
        } else {
            const checkedCount = selectedFiles.filter(
                (f) => f.status === "success" && f.checked && f.patchedBuffer,
            ).length;
            patchBtn.disabled = checkedCount === 0;
            const label =
                checkedCount > 1
                    ? `Download Selected (${checkedCount})`
                    : checkedCount > 0
                      ? "Download Selected"
                      : "Patch Videos";
            patchBtn.querySelector("span").textContent = label;
        }
    } else {
        const pendingCount = selectedFiles.filter(
            (f) => f.status === "pending",
        ).length;
        patchBtn.disabled =
            pendingCount === 0 || currentFlowState === "patching";
        const label =
            pendingCount > 1
                ? `Patch Videos (${pendingCount})`
                : "Patch Videos";
        patchBtn.querySelector("span").textContent = label;
    }
}

function getDimensionsFromMp4Container(bytes, view) {
    const top = parseBoxes(bytes, view, 0, bytes.length);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) return null;

    const moovCh = parseBoxes(
        bytes,
        view,
        moov.offset + getBoxHeaderSize(moov),
        moov.end,
    );
    for (const trak of moovCh.filter((b) => b.type === "trak")) {
        const tch = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const tkhd = tch.find((b) => b.type === "tkhd");
        const mdia = tch.find((b) => b.type === "mdia");
        if (!tkhd || !mdia) continue;

        const mch = parseBoxes(
            bytes,
            view,
            mdia.offset + getBoxHeaderSize(mdia),
            mdia.end,
        );
        const hdlr = mch.find((b) => b.type === "hdlr");
        if (!hdlr) continue;
        if (findHandlerType(bytes, hdlr) !== "vide") continue;

        const cs = tkhd.offset + getBoxHeaderSize(tkhd);
        const ver = bytes[cs];
        const matrixOff = cs + (ver === 0 ? 40 : 52);
        const widthOff = cs + (ver === 0 ? 76 : 88);

        if (widthOff + 8 > tkhd.end) continue;

        let w = view.getUint32(widthOff, false) >> 16;
        let h = view.getUint32(widthOff + 4, false) >> 16;

        if (matrixOff + 36 <= tkhd.end) {
            const a = view.getInt32(matrixOff, false);
            const b = view.getInt32(matrixOff + 4, false);
            const isRotated90 = Math.abs(a) < 1000 && Math.abs(b) > 60000;
            if (isRotated90) {
                [w, h] = [h, w];
            }
        }

        if (w > 0 && h > 0) return { width: w, height: h };
    }
    return null;
}

function getVideoDurationAndResolution(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const ab = e.target.result;
            const bytes = new Uint8Array(ab);
            const view = new DataView(ab);
            const containerDims = getDimensionsFromMp4Container(bytes, view);

            const video = document.createElement("video");
            video.preload = "metadata";
            video.muted = true;
            video.playsInline = true;
            let settled = false;
            let objectUrl = null;

            function cleanup(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                video.onloadedmetadata = null;
                video.onerror = null;
                video.src = "";
                video.load();
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                resolve(result);
            }

            objectUrl = URL.createObjectURL(file);
            const timeoutId = setTimeout(() => {
                if (containerDims) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup(null);
                }
            }, METADATA_TIMEOUT_MS);

            video.src = objectUrl;
            video.onloadedmetadata = () => {
                if (settled) return;
                const bw = video.videoWidth;
                const bh = video.videoHeight;
                const duration = video.duration;
                if (
                    containerDims &&
                    (bw === 0 || bh === 0 || !Number.isFinite(duration))
                ) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else if (containerDims) {
                    cleanup({
                        duration,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup({ duration, width: bw, height: bh });
                }
            };
            video.onerror = () => {
                if (containerDims) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup(null);
                }
            };
        };
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(file);
    });
}

async function patchSingleFile(item) {
    if (isCancelled) throw new Error("Cancelled");

    const inputBuffer = await item.file.arrayBuffer();
    if (isCancelled) throw new Error("Cancelled");

    const videoInfo = await getVideoDurationAndResolution(item.file).catch(() => null);
    if (videoInfo) {
        logMessage(
            `  Source: ${videoInfo.width}x${videoInfo.height} (${videoInfo.width > videoInfo.height ? "landscape" : "portrait"})`,
            "info",
        );
    } else {
        logMessage("  Source: original MP4/MOV file", "info");
    }

    // The only processing step: run the audio-inflation MP4 patcher.
    // No FFmpeg, frame interpolation, resizing, transcoding, normalization,
    // bitrate conversion, FPS validation, or other compression pipeline.
    logMessage("  Applying audio-inflation patch only...", "info");
    const patchResult = await patchAudioInflationInWorker(inputBuffer);
    if (isCancelled) throw new Error("Cancelled");

    logMessage(
        `  Audio inflation complete (${patchResult.multiplier}x, ${patchResult.fakeAudioCount.toLocaleString()} added samples).`,
        "success",
    );

    let movThumbnail = null;
    try {
        movThumbnail = await captureVideoFrame(item.file);
    } catch (_) {
        movThumbnail = null;
    }

    return {
        finalBuffer: patchResult.buffer,
        outputName: getOutputFilename(item.file),
        mimeType: "video/mp4",
        prePatchBuffer: null,
        movThumbnail,
        tiktokUploadBlob: null,
        tiktokUploadMeta: null,
        tiktokUploadValidation: null,
    };
}

async function downloadSelectedFiles() {
    const selectedToDownload = selectedFiles.filter(
        (f) => f.status === "success" && f.checked && f.patchedBuffer,
    );
    if (selectedToDownload.length === 0) return;

    logMessage(
        `Starting download for ${selectedToDownload.length} file(s)...`,
        "info",
    );

    for (let i = 0; i < selectedToDownload.length; i++) {
        const item = selectedToDownload[i];
        logMessage(`  Downloading: ${item.outputName}`, "success");
        downloadBuffer(item.patchedBuffer, item.outputName, item.mimeType);
        item.patchedBuffer = null;
        item.file = null;
        item.checked = false;

        if (i < selectedToDownload.length - 1) {
            await new Promise((r) => setTimeout(r, DOWNLOAD_INTERVAL_MS));
        }
    }

    logMessage("All selected downloads triggered successfully.", "success");
    renderFileList();
    updatePatchButton();
}

dropZone.addEventListener("click", () => {
    fileInput.click();
});

fileInput.addEventListener("change", (event) => {
    if (event.target.files.length > 0) addFiles(event.target.files);
    fileInput.value = "";
});

clearBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (currentFlowState === "patching") {
        isCancelled = true;
        logMessage("Cancelling active interpolation progress...", "warning");
        
        return;
    }
    selectedFiles = [];
    currentFlowState = "idle";
    setLogCopyVisible(false);
    hideProgress();
    clearLog();
    renderFileList();
    updatePatchButton();
});

dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
});

let wakeLock = null;

async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
            if (currentFlowState === "patching") {
                acquireWakeLock();
            }
        });
    } catch (_) {
        wakeLock = null;
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

document.addEventListener("visibilitychange", () => {
    if (
        document.visibilityState === "visible" &&
        currentFlowState === "patching" &&
        !wakeLock
    ) {
        acquireWakeLock();
    }
});

patchBtn.addEventListener("click", async () => {
    if (!requireActiveSubscription()) return;
    const failedItems = selectedFiles.filter((f) => f.status === "error");
    if (failedItems.length > 0) {
        for (const item of failedItems) {
            item.status = "pending";
            item.checked = true;
            item.patchedBuffer = null;
        }
        currentFlowState = "idle";
        setLogCopyVisible(false);
        renderFileList();
        updatePatchButton();
    }

    if (currentFlowState === "completed") {
        const currentVfi = !!enableInterpolation?.checked;
        const currentRes =
            document.getElementById("outputResolution")?.value || "1080";
        const settingsChanged =
            currentVfi !== lastPatchedVfi || currentRes !== lastPatchedRes;

        if (settingsChanged) {
            for (const item of selectedFiles) {
                if (item.status === "success" || item.status === "error") {
                    item.status = "pending";
                    item.checked = true;
                    item.patchedBuffer = null;
                }
            }
            currentFlowState = "idle";
            setLogCopyVisible(false);
            renderFileList();
            updatePatchButton();
        } else {
            const checkedCount = selectedFiles.filter(
                (f) =>
                    f.status === "success" && f.checked && f.patchedBuffer,
            ).length;
            if (checkedCount > 0) {
                await downloadSelectedFiles();
                return;
            }
        }
    }

    const pendingItems = selectedFiles.filter((f) => f.status === "pending");
    if (pendingItems.length === 0) return;

    currentFlowState = "patching";
    lastPatchedVfi = !!enableInterpolation?.checked;
    lastPatchedRes =
        document.getElementById("outputResolution")?.value || "1080";
    setLogCopyVisible(false);
    clearLog();
    patchBtn.disabled = true;
    clearBtn.innerText = "Cancel";
    clearBtn.disabled = false;
    showProgress();
    await acquireWakeLock();

    isCancelled = false;
    let successCount = 0;

    for (let i = 0; i < pendingItems.length; i++) {
        if (isCancelled) {
            break;
        }
        const item = pendingItems[i];
        setProgress(Math.round((i / pendingItems.length) * 100));

        item.status = "processing";
        renderFileList();
        logMessage(`[${i + 1}/${pendingItems.length}] ${item.name}`, "info");

        try {
            const result = await patchSingleFile(item);
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "success";
            item.patchedBuffer = result.finalBuffer;
            item.tiktokUploadBlob = result.tiktokUploadBlob;
            item.tiktokUploadMeta = result.tiktokUploadMeta;
            item.tiktokUploadValidation = result.tiktokUploadValidation;
            item.outputName = result.outputName;
            item.mimeType = result.mimeType;
            item.checked = true;
            successCount++;

            if (
                item.status === "success" &&
                result.finalBuffer &&
                result.finalBuffer.byteLength !== undefined
            ) {
                try {
                    if (isCancelled) break;
                    const blob = new Blob([result.finalBuffer], {
                        type: result.mimeType,
                    });

                    let thumbnail = null;
                    if (result.movThumbnail) {
                        thumbnail = result.movThumbnail;
                        logMessage(
                            "Thumbnail captured from MOV extraction",
                            "info",
                        );
                    }
                    if (!thumbnail) {
                        try {
                            thumbnail = await captureVideoFrame(blob);
                            if (thumbnail) {
                                logMessage(
                                    "Thumbnail captured from output",
                                    "info",
                                );
                            }
                        } catch (_) {
                            // HEVC output can't be decoded by browser
                        }
                    }
                    if (!thumbnail && !isMovFile(item.file)) {
                        thumbnail = await captureVideoFrame(item.file);
                        if (thumbnail) {
                            logMessage(
                                "Thumbnail captured from original file",
                                "info",
                            );
                        }
                    }
                    if (isCancelled) break;

                    if (!thumbnail) {
                        logMessage(
                            "Warning: No thumbnail available for history entry",
                            "warning",
                        );
                    }
                    await saveRecord({
                        id: self.crypto.randomUUID(),
                        name: result.outputName,
                        size: result.finalBuffer.byteLength,
                        timestamp: Date.now(),
                        thumbnail,
                        blob,
                        mimeType: result.mimeType,
                        tiktokBlob: result.tiktokUploadBlob,
                        tiktokMeta: result.tiktokUploadMeta,
                        tiktokValidation: result.tiktokUploadValidation,
                    });

                    void reportCompressionActivity({
                        inputName: item.file?.name || "",
                        outputName: result.outputName,
                        inputBytes: item.file?.size || 0,
                        outputBytes: result.finalBuffer.byteLength,
                        outputMime: result.mimeType,
                    });

                    await renderHistoryList();
                } catch (dbError) {
                    logMessage(
                        `  Database save skipped: ${dbError.message}`,
                        "warning",
                    );
                }
            }

            if (i < pendingItems.length - 1) {
                if (isCancelled) {
                    break;
                }
                await new Promise((r) => setTimeout(r, PATCH_INTERVAL_MS));
                if (isCancelled) {
                    break;
                }
            }
        } catch (error) {
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "error";
            item.checked = false;
            const msg =
                error instanceof Error
                    ? error.message
                    : String(error);
            logMessage(`  Error: ${msg}`, "error");
        }

        renderFileList();
    }

    if (isCancelled) {
        for (const item of pendingItems) {
            if (item.status === "processing" || item.status === "pending") {
                item.status = "pending";
            }
        }
        currentFlowState = "idle";
        setProgress(0);
        hideProgress();
        releaseWakeLock();
        setLogCopyVisible(false);
        clearBtn.innerText = "Clear";
        logMessage("Interpolation progress cancelled by user.", "warning");
        renderFileList();
        updatePatchButton();
        // Remix Icon CSS handles rendering
        return;
    }

    currentFlowState =
        successCount === pendingItems.length ? "completed" : "idle";
    setProgress(100);
    releaseWakeLock();
    setLogCopyVisible(true);
    logMessage(
        `Done. ${successCount}/${pendingItems.length} file(s) patched successfully.`,
        successCount === pendingItems.length ? "success" : "warning",
    );
    hideProgress();

    clearBtn.innerText = "Clear";
    clearBtn.disabled = false;
    renderFileList();
    updatePatchButton();
    // Remix Icon CSS handles rendering
});

async function renderHistoryList() {
    const records = await getAllRecords();
    historyList.innerHTML = "";
    historyBadge.textContent = records.length;
    const navHistoryCount = document.getElementById("navHistoryCount");
    if (navHistoryCount) {
        navHistoryCount.textContent = String(records.length);
        navHistoryCount.hidden = records.length === 0;
    }

    if (records.length === 0) {
        historyList.innerHTML = `<div class="history-item-empty">No history records found</div>`;
        // Remix Icon CSS handles rendering
        return;
    }

    for (const record of records) {
        const item = document.createElement("div");
        item.className = "history-item";

        const thumb = document.createElement("div");
        thumb.className = "history-thumbnail";
        if (record.thumbnail?.startsWith(SAFE_THUMBNAIL_PREFIX)) {
            const img = document.createElement("img");
            img.src = record.thumbnail;
            img.alt = "preview";
            thumb.appendChild(img);
        } else {
            const icon = document.createElement("i");
            icon.className = "ri-movie-2-fill";
            thumb.appendChild(icon);
        }

        const body = document.createElement("div");
        body.className = "history-item-body";

        const name = document.createElement("div");
        name.className = "history-item-name";
        name.textContent = record.name;

        const meta = document.createElement("div");
        meta.className = "history-item-meta";
        const needsReprocessForTikTok = !(record.tiktokBlob && record.tiktokValidation?.valid);
        meta.textContent = `${formatFileSize(record.size)} • ${new Date(
            record.timestamp,
        ).toLocaleTimeString()}${needsReprocessForTikTok ? " • TikTok: សូម Process ម្ដងទៀត" : " • TikTok Draft ready"}`;

        body.appendChild(name);
        body.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "history-item-actions";

        const dlBtn = document.createElement("button");
        dlBtn.className = "history-btn";
        const dlIcon = document.createElement("i");
        dlIcon.className = "ri-download-fill";
        dlBtn.appendChild(dlIcon);
        dlBtn.addEventListener("click", () => {
            downloadBuffer(
                record.blob || record.buffer,
                record.name,
                record.mimeType || "video/mp4",
            );
        });

        const delBtn = document.createElement("button");
        delBtn.className = "history-btn history-btn-delete";
        const delIcon = document.createElement("i");
        delIcon.className = "ri-delete-bin-fill";
        delBtn.appendChild(delIcon);
        delBtn.addEventListener("click", async () => {
            await deleteRecord(record.id);
            await renderHistoryList();
        });

        const uploadBtn = document.createElement("button");
        uploadBtn.className = "history-btn history-btn-tiktok";
        uploadBtn.title = record.tiktokBlob && record.tiktokValidation?.valid
            ? "Upload this clean artifact to TikTok Inbox/Draft"
            : "Process this video again to create a valid clean TikTok artifact";
        uploadBtn.disabled = !(record.tiktokBlob && record.tiktokValidation?.valid);
        const uploadIcon = document.createElement("i");
        uploadIcon.className = "ri-tiktok-fill";
        uploadBtn.appendChild(uploadIcon);
        uploadBtn.addEventListener("click", () => {
            if (!(record.tiktokBlob && record.tiktokValidation?.valid)) {
                logMessage("This history item has no clean TikTok artifact. Process the video again.", "warning");
                return;
            }
            void openTikTokUploadReview({
                blob: record.tiktokBlob,
                filename: record.name,
                metadata: record.tiktokMeta,
                source: "history",
            });
        });

        actions.appendChild(dlBtn);
        actions.appendChild(uploadBtn);
        actions.appendChild(delBtn);

        item.appendChild(thumb);
        item.appendChild(body);
        item.appendChild(actions);

        historyList.appendChild(item);
    }
    // Remix Icon CSS handles rendering
}

historyHeader.addEventListener("click", () => {
    const container = historyHeader.parentElement;
    container.classList.toggle("collapsed");
    const expanded = !container.classList.contains("collapsed");
    document.getElementById("historyToggleBtn")?.setAttribute(
        "aria-expanded",
        String(expanded),
    );
});

clearHistoryBtn.addEventListener("click", async () => {
    await clearAllRecords();
    await renderHistoryList();
});

let scrollPosition = 0;

function lockScroll() {
    scrollPosition = window.pageYOffset;
    document.body.style.overflow = "hidden";
    document.body.style.top = `-${scrollPosition}px`;
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
}

function unlockScroll() {
    document.body.style.overflow = "";
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, scrollPosition);
}

const enableInterpolation = document.getElementById("enableInterpolation");
const vfiModal = document.getElementById("vfiModal");
const closeVfiModalBtn = document.getElementById("closeVfiModalBtn");
const cancelVfiBtn = document.getElementById("cancelVfiBtn");
const confirmVfiBtn = document.getElementById("confirmVfiBtn");

if (enableInterpolation && vfiModal) {
    const resolutionBox = document.getElementById("vfiResolutionBox");

    enableInterpolation.addEventListener("change", () => {
        if (enableInterpolation.checked) {
            vfiModal.classList.add("active");
            lockScroll();
        }
        if (resolutionBox) {
            resolutionBox.style.display = enableInterpolation.checked
                ? "block"
                : "none";
        }
        updatePatchButton();
    });

    const outputResolution = document.getElementById("outputResolution");
    if (outputResolution) {
        outputResolution.addEventListener("change", () => {
            updatePatchButton();
        });
    }

    const closeModal = () => {
        vfiModal.classList.remove("active");
        unlockScroll();
        if (resolutionBox) {
            resolutionBox.style.display = enableInterpolation.checked
                ? "block"
                : "none";
        }
    };

    const cancelModal = () => {
        enableInterpolation.checked = false;
        closeModal();
    };

    closeVfiModalBtn?.addEventListener("click", cancelModal);
    cancelVfiBtn?.addEventListener("click", cancelModal);
    confirmVfiBtn?.addEventListener("click", closeModal);

    vfiModal.addEventListener("click", (e) => {
        if (e.target === vfiModal) cancelModal();
    });
}

const tiktokModal = document.getElementById("tiktokModal");
const tiktokStudioBtn = document.getElementById("tiktokStudioBtn");
const closeTiktokModalBtn = document.getElementById("closeTiktokModalBtn");
const cancelTiktokModalBtn = document.getElementById("cancelTiktokModalBtn");
const confirmTiktokBtn = document.getElementById("confirmTiktokBtn");

function isMobileDevice() {
    return (
        window.innerWidth <= MOBILE_BREAKPOINT ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
}

if (tiktokStudioBtn && tiktokModal) {
    tiktokStudioBtn.addEventListener("click", (e) => {
        if (isMobileDevice()) {
            e.preventDefault();
            tiktokModal.classList.add("active");
            lockScroll();
        }
    });

    const closeTiktokModal = () => {
        tiktokModal.classList.remove("active");
        unlockScroll();
    };

    closeTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    cancelTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    confirmTiktokBtn?.addEventListener("click", closeTiktokModal);

    tiktokModal.addEventListener("click", (e) => {
        if (e.target === tiktokModal) closeTiktokModal();
    });
}

initializeApp();

const changelogContainer = document.getElementById("changelogContainer");
if (changelogContainer) {
    initChangelog(changelogContainer);
}
