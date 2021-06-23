const fs = require('fs');
const TradeOfferManager = require('steam-tradeoffer-manager');
const backpack = require('./backpacktf');
const AutomaticOffer = require('./automatic-offer');

const POLLDATA_FILENAME = 'polldata.json';

let manager, log, Config;

exports.register = (Automatic) => {
    log = Automatic.log;
    manager = Automatic.manager;
    Config = Automatic.config;

    if (fs.existsSync(POLLDATA_FILENAME)) {
        try {
            manager.pollData = JSON.parse(fs.readFileSync(POLLDATA_FILENAME));
        } catch (e) {
            log.verbose("polldata.json corrupto: ", e);
        }
    }

    manager.on('pollData', savePollData);
    manager.on('newOffer', handleOffer);
    manager.on('receivedOfferChanged', offerStateChanged);
};

function savePollData(pollData) {
    fs.writeFile(POLLDATA_FILENAME, JSON.stringify(pollData), (err) => {
        if (err) log.warn("Error writing poll data: " + err);
    });
}

function handleOffer(tradeoffer) {
    const offer = new AutomaticOffer(tradeoffer);
    if (offer.isGlitched()) {
        offer.log("warn", `recibido de ${offer.partner64()} esta bugeado (Steam puede estar caido).`);
        return;
    }

    offer.log("info", `recibido de ${offer.partner64()}`);

    if (offer.fromOwner()) {
        offer.log("info", `es del dueño, aceptando`);
        offer.accept().then((status) => {
            offer.log("trade", `aceptado${status === 'pendiente' ? "; confirmacion requerida" : ""}`);
            log.debug("Owner offer: sin enviar confirmacion a backpack.tf");
        }).catch((msg) => {
            offer.log("warn", `(owner offer) no se puedo aceptar: ${msg}`);
        });
        return;
    }
    
    if (offer.isOneSided()) {
        if (offer.isGiftOffer() && Config.get("acceptGifts")) {
            offer.log("info", `es un pelotudo y esta regalando`);
            offer.accept().then((status) => {
                offer.log("trade", `(gift offer) aceptada${status === 'pendiente' ? "; confirmacion requerida" : ""}`);
                log.debug("Gift offer: sin enviar confirmacion a backpack.tf");
            }).catch((msg) => {
                offer.log("warn", `(gift offer) no se puedo aceptar: ${msg}`);
            });
        } else {
            offer.log("info", "es un regalito, salteando");
        }
        return;
    }
    
    if (offer.games.length !== 1 || offer.games[0] !== 440) {
        offer.log("info", `contiene items que no son de TF2, salteando`);
        return;
    }

    offer.log("debug", `handling buy orders`);
    let ok = backpack.handleBuyOrdersFor(offer);
    if (ok === false) return;
    offer.log("debug", `handling sell orders`);
    backpack.handleSellOrdersFor(offer).then((ok) => {
        if (ok) {
            offer.log("debug", `finalizing offer`);
            backpack.finalizeOffer(offer);
        }
    });
}

function offerStateChanged(tradeoffer, oldState) {
    const offer = new AutomaticOffer(tradeoffer, {countCurrency: false});
    offer.log("verbose", `cambio de estado: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${offer.stateName()}`);

    if (offer.state() === TradeOfferManager.ETradeOfferState.InvalidItems) {
        offer.log("info", "no es valido, cancelando");
        offer.decline().then(() => offer.log("debug", "declined")).catch(() => offer.log("info", "(Offer was marked invalid after being accepted)"));
    }
}

