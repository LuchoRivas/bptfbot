const Utils = require('./utils');
const backpack = require('./backpacktf');
const Login = require('./login');
const Confirmations = require('./confirmations');
const appConsole = require('./console');

let steam, log, Config, manager, automatic;

let communityCookies;
let g_RelogInterval = null;

exports.checkOfferCount = checkOfferCount;
exports.register = (Automatic) => {
    steam = Automatic.steam;
    log = Automatic.log;
    Config = Automatic.config;
    manager = Automatic.manager;
    automatic = Automatic;

    Login.register(Automatic);

    steam.on('debug', msg => log.debug(msg));
    steam.on('sessionExpired', relog);
};

function saveCookies(cookies, quiet) {
    communityCookies = cookies;
    steam.setCookies(cookies);
    if (!quiet) log.info("Logueado a Steam!");
    else log.debug("Logueado a Steam: cookies guardadas");
}

function getBackpackToken() {
    let acc = Config.account();

    if (acc && acc.bptfToken) {
        return acc.bptfToken;
    }

    return backpack.getToken();
}

exports.connect = () => {
    let acc = Config.account();
    let login;

    if (acc && acc.sentry && acc.oAuthToken) {
        log.info("Logueandose a Steam con token OAuth");
        login = Login.oAuthLogin(acc.sentry, acc.oAuthToken);
    } else {
        login = Login.promptLogin();
    }

    login.then(saveCookies).then(tryLogin).then(getBackpackToken).then(setupTradeManager).catch((err) => {
        log.error("Cannot login to Steam: " + err.message);
        tryLogin().then(getBackpackToken).then(setupTradeManager);
    });
}

function tryLogin() {
    return new Promise((resolve) => {
        function retry() {
            return tryLogin().then(resolve);
        }

        Login.isLoggedIn().then(resolve).catch(([err, loggedIn, familyView]) => {
            if (err) {
                log.error("No se puede chequear el login de Steam: " + err);
                Utils.after.seconds(10).then(retry);
            } else if (!loggedIn) {
                log.warn("OAuth token expirado.");
                Login.promptLogin().then(saveCookies).then(retry);
            } else if (familyView) {
                log.warn("Family View actiado.");
                Login.unlockFamilyView().then(retry);
            }
        });
    });
}

function heartbeatLoop() {
    function loop(timeout) { setTimeout(heartbeatLoop, timeout); }
    backpack.heartbeat().then(loop, loop);
}

function setupTradeManager() {
    backpack.heartbeat().then((timeout) => {
        const acc = Config.account();

        if (Confirmations.enabled()) {
            if (acc.identity_secret) {
                log.info("Iniciando 'Steam confirmation checker' (aceptando " + automatic.confirmationsMode() + ")");
                Confirmations.setSecret(acc.identity_secret);
            } else {
                log.warn("No se aceptaran las ofertas de manera automatica. Para realizar esto se debera porporcionar un identity_secret. Tipear help identity_secret para ayuda con esto. Tambien se puede esconder con `confirmations none`.");
            }
        } else {
            log.verbose("Confirmaciones deshabilitadas.");
        }

        // Start the input console
        log.debug("Iniciando consola.");
        appConsole.startConsole(automatic);
        
        if (!g_RelogInterval) {
            g_RelogInterval = setInterval(relog, 1000 * 60 * 60 * 1); // every hour
        }
        setTimeout(heartbeatLoop, timeout);

        manager.setCookies(communityCookies, (err) => {
            if (err) {
                log.error("No se puedo obetener apiKey desde Steam: " + err);
                process.exit(1);
            }

            log.info(`Automatic listo!. Sell orders habilitadas; Buy orders ${automatic.buyOrdersEnabled() ? "habilitadas" : "deshabilitadas (tipear buyorders toggle para habilitar, help buyorders para ayuda)"}`);
            checkOfferCount();
            setInterval(checkOfferCount, 1000 * 60 * 3);
        });
    }).catch((timeout) => {
        if (timeout === "getToken") {
            backpack.getToken().then(setupTradeManager);
        } else {
            Utils.after.timeout(timeout).then(setupTradeManager);
        }
    });
}

function relog() {
    const acc = Config.account();
    if (acc && acc.sentry && acc.oAuthToken) {
        log.verbose("Renovando sesion web");
        Login.oAuthLogin(acc.sentry, acc.oAuthToken, true).then((cookies) => {
            saveCookies(cookies, true);
            log.verbose("Sesion web renovada!");
        }).catch((err) => {
            log.debug("Fallo el re-log (chequeando login): " + err.message);
            Login.isLoggedIn()
                .then(() => log.verbose("Sesion web aun valida"))
                .catch(() => log.warn("La sesion web expiro. Para renovarla, desloguearse (type logout), restartear Automatic y logearse nuevamente"));
        });
    } else {
        log.verbose("No se puedo guardar el token OAuth, imposible renovar la sesion web.");
    }
}

function checkOfferCount() {
    if (manager.apiKey === null) return;

    return Utils.getJSON({
        url: "https://api.steampowered.com/IEconService/GetTradeOffersSummary/v1/?key=" + manager.apiKey
    }).then(([_, response]) => {
        if (!response) {
            log.warn("No se pueden contar las ofertar: respuesta deforme");
            log.debug(`apiKey: ${manager.apiKey}`);
            return;
        }

        let pending_sent = response.pending_sent_count,
            pending_received = response.pending_received_count;

        log.verbose(`${pending_received} oferta${pending_received === 1 ? '' : 's'} (${response.escrow_received_count} esperando), ${pending_sent} oferta enviada${pending_sent === 1 ? '' : 's'} (${response.escrow_sent_count} esperando)`);
    }).catch((msg) => {
        log.warn("No se pueden contar las ofertar: " + msg);
        log.debug(`apiKey: ${manager.apiKey}`);
    });
}
