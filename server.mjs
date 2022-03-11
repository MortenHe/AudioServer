import createPlayer from 'mplayer-wrapper';
const player = createPlayer();
import { spawn } from 'child_process';

//Zeit Formattierung laden: [5, 13, 22] => 05:13:22
import timelite from 'timelite';

//Filesystem und Path Abfragen fuer Playlist und weitere Utils
import path from 'path';
import glob from "glob-promise";
import _ from "underscore";
import fs from 'fs-extra';
//const exec = require('child_process').exec;
import util from 'util';
import exec from 'child_process';
//import exec from = util.promisify(require('child_process').exec);
import execSync from 'child_process';
import singleSoundPlayer from 'node-wav-player';

import { URL } from 'url';
const __dirname = new URL('.', import.meta.url).pathname;

const configFile = await fs.readJson(__dirname + '/config.json');

import { WebSocketServer } from 'ws';
import { exit } from 'process';
const wss = new WebSocketServer({ port: configFile.port, clientTracking: true });

//Wo liegen Audiodateien
const audioDir = configFile.audioDir;
const audioFilesDir = audioDir + "/wap/mp3";
const readFilesDir = audioDir + "/wap/wav";
console.log("audio files are located in " + audioFilesDir);

//Befehl fuer Autostart in Datei schreiben
fs.writeFile(__dirname + "/../wss-install/last-player", "AUTOSTART=sudo " + __dirname + "/startnode.sh");

//Zeit wie lange bis Shutdown durchgefuhert wird bei Inaktivitaet
const countdownTime = configFile.countdownTime;
var countdownID = null;

//GPIO Buttons starten, falls konfiguriert
if (configFile.GPIOButtons) {
    console.log("use GPIO Buttons");
    const buttons_gpio = spawn("node", [__dirname + "/../WSGpioButtons/button.js", configFile.port]);
    buttons_gpio.stdout.on("data", (data) => {
        console.log("button event: " + data);
    });
}

//USB RFID Reader starten, falls konfiguriert
if (configFile.USBRFIDReader) {
    console.log("use USB RFID Reader");
    const rfid_usb = spawn("node", [__dirname + "/../WSRFID/rfid.js", configFile.port]);
    rfid_usb.stdout.on('data', (data) => {
        console.log("rfid event: " + data);
    });
}

//STT starten, falls konfiguriert
if (configFile.STT) {
    console.log("use Speach to text");

    //JSON-File fuer Indexerzeugung erstellen
    const stt_index = spawn("node", [__dirname + "/../WSSTT/createJsonIndexFile.js", configFile.port]);
    stt_index.stdout.on('data', (data) => {
        console.log("stt index event: " + data);
    });

    //STT-Suche
    const stt_search = spawn("node", [__dirname + "/../WSSTT/stt.js", configFile.port]);
    stt_search.stdout.on('data', (data) => {
        console.log("stt search event: " + data);
    });
}

//Aktuelle Infos zu Volume / Position in Song / Position innerhalb der Playlist / Playlist / PausedStatus merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
const data = [];
data["volume"] = configFile.volume;
data["position"] = -1;
data["files"] = [];
data["paused"] = false;
data["activeItem"] = "";
data["activeItemName"] = "";
data["activeItemLang"] = "";
data["playlist"] = "";
data["fileLength"] = 0;
data["secondsPlayed"] = 0;
data["time"] = 0;
data["countdownTime"] = -1;
data["userMode"] = configFile.userMode;
//TODO: Eigene Variable -> Kein userMode fuer SH mehr
data["pageTitle"] = configFile.userMode;
data["mixFiles"] = [];
data["mainJSON"] = {};

//Wo liegen die Herz-Mix-Files?
setMixDir();

//JSON fuer Oberflaeche erstellen mit Infos zu aktiven Foldern, Filtern, etc.
getMainJSON();

//JSON nach x Sekunden nochmal laden, damit Aenderungen von Nextcloud Sync sichtbar werden (neue Playlists)
setTimeout(() => {
    console.log("reload main json");
    getMainJSON();
    sendClientInfo(["mainJSON"]);
}, 20000);

//initiale Lautstaerke setzen
setVolume();

//Wenn Playlist fertig ist (wird jede Sekunde aufgerufen)
player.on('playlist-finish', () => {

    //Position zuruecksetzen
    data["position"] = -1;

    //Wenn Countdown noch nicht laueft
    if (!countdownID) {
        console.log("playlist finished");

        //Info in JSON-Datei schreiben (position: -1)
        writeSessionJson();

        //Countdown starten
        startCountdown();
    }

    //Clients informieren, dass Playlist fertig ist (position -1)
    sendClientInfo(["position"]);
});

//Wenn bei Track change der Filename geliefert wird
player.on('filename', (filename) => {

    //Position in Playlist ermitteln
    data["position"] = data["files"].indexOf(data["playlist"] + "/" + filename);

    //neue Position in Session-JSON-File schreiben
    writeSessionJson();

    //Position-Infos an Clients schicken
    sendClientInfo(["position"]);
});

//Wenn bei Track change die Filelength geliefert wird, diese merken
player.on('length', (length) => {
    data["fileLength"] = length;
});

//Wenn sich ein Titel aendert (durch Nutzer oder durch den Player)
player.on('track-change', () => {

    //Neuen Dateinamen und Dateilaenge liefern
    player.getProps(['filename']);
    player.getProps(['length']);
});

//Infos aus letzter Session auslesen, falls die Datei existiert
if (fs.pathExists(__dirname + "/lastSession.json")) {
    try {
        const lastSessionObj = await fs.readJSON(__dirname + "/lastSession.json");
        data["playlist"] = lastSessionObj.path;
        console.log("load playlist from last session " + data["playlist"]);

        //Letzte Infos laden
        data["activeItem"] = lastSessionObj.activeItem;
        data["activeItemName"] = lastSessionObj.activeItemName;
        data["activeItemLang"] = lastSessionObj.activeItemLang;
        data["position"] = lastSessionObj.position;

        //diese Playlist zu Beginn spielen
        await setPlaylist(true, lastSessionObj.readPlaylist);
    }
    catch (e) {
        console.log("invalid lastSession.json file");
    }
}

//TimeFunktion starten, die aktuelle Laufzeit des Titels liefert
startTimer();

//Aktuellen Inhalt des MixFolders holen
getMixFiles();

//Files fuer Suche ermitteln
getSearchFiles();

//Wenn sich ein WebSocket mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Wenn WS eine Nachricht an WSS sendet
    ws.on('message', async function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        const obj = JSON.parse(message);
        const type = obj.type;
        const value = obj.value;

        //Array von Messages erstellen, die an Client gesendet werden
        const messageArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //neue Playlist laden (ueber Browser-Aufruf) oder per RFID
            case "set-playlist": case "set-rfid-playlist": case "set-playlist-read":
                console.log(type + JSON.stringify(value));

                //Audio-Verzeichnis und aktives Item merken
                data["playlist"] = audioFilesDir + "/" + value.mode + "/" + value.path;
                data["activeItem"] = value.path;
                data["activeItemName"] = value.name;
                data["activeItemLang"] = value.lang || "de-DE";

                //Countdown abbrechen
                resetCountdown();

                //neue Playlist in Session-JSON-File schreiben
                writeSessionJson();

                //Soll Name der Playlist vorgelesen werden (wenn Playlist per STT gestartet wurde)
                const readPlaylist = (type === 'set-playlist-read');

                //Setlist erstellen und starten
                await setPlaylist(false, readPlaylist);

                //Es ist nicht mehr pausiert
                data["paused"] = false;

                //Zusaetzliche Nachricht an clients
                messageArr.push("paused", "activeItem", "activeItemName", "files");
                break;

            //Song wurde vom Nutzer weitergeschaltet
            case 'change-item':
                console.log("change-item " + value);

                //Countdown abbrechen
                resetCountdown();

                //wenn der naechste Song kommen soll
                if (value === 1) {

                    //Wenn wir noch nicht beim letzten Titel sind, zum naechsten Titel springen
                    if (data["position"] < (data["files"].length - 1)) {
                        player.next();
                        playSound("track-change.wav");
                    }

                    //wir sind beim letzten Titel
                    else {
                        console.log("no next at last track");

                        //Wenn Titel pausiert war, wieder unpausen
                        if (data["paused"]) {
                            player.playPause();
                        }
                    }
                }

                //der vorherige Titel soll kommen
                else {

                    //Wenn wir nicht beim 1. Titel sind
                    if (data["position"] > 0) {

                        //Wenn weniger als x Sekunden vergangen sind -> zum vorherigen Titel springen
                        if (data["secondsPlayed"] < 3) {
                            console.log("go to previous track");
                            player.previous();
                            playSound("track-change.wav");
                        }

                        //Titel ist schon mehr als x Sekunden gelaufen -> Titel nochmal von vorne starten
                        //Gespielte Sekunden manuell auf 0 setzen. Damit mit schnellen Klicks der vorherige Titel ausgewaehlt werden kann
                        else {
                            console.log("repeat current track");
                            data["secondsPlayed"] = 0;
                            player.seekPercent(0);
                            playSound("track-same.wav");
                        }
                    }

                    //wir sind beim 1. Titel
                    else {

                        //Playlist nochmal von vorne starten
                        console.log("first track from start");
                        player.seekPercent(0);
                        playSound("track-same.wav");

                        //Wenn Titel pausiert war, wieder unpausen
                        if (data["paused"]) {
                            player.playPause();
                        }
                    }
                }

                //Pausierung zuruecksetzen und Clients informieren
                data["paused"] = false;
                messageArr.push("paused");
                break;

            //Sprung zu einem bestimmten Titel in Playlist
            case "jump-to":

                //Countdown abbrechen
                resetCountdown();

                //Wenn Playlist schon fertig ist, wieder von vorne beginnen, Playlist laden und starten
                if (data["position"] === -1) {
                    data["position"] = 0;
                    player.exec("loadlist " + __dirname + "/playlist.txt");
                }

                //Wie viele Schritte in welche Richtung springen?
                const jumpTo = value - data["position"];
                console.log("jump-to " + jumpTo);

                //wenn nicht auf den bereits laufenden geklickt wurde, zu gewissem Titel springen
                if (jumpTo !== 0) {
                    player.exec("pt_step " + jumpTo);
                }

                //es wurde auf den bereits laufenden Titel geklickt -> diesen wieder von vorne abspielen
                else {
                    player.seekPercent(0);
                }

                //Pausierung zuruecksetzen und Info an Clients
                data["paused"] = false;
                messageArr.push("paused");
                break;

            //Innerhalb des Titels spulen
            case "seek":

                //seek +/- 10 Sek in item
                const seekTo = value ? 10 : -10;
                player.seek(seekTo);
                break;

            //Pause, wenn Playlist gerade laeuft
            case 'pause-if-playing':

                //Wenn wir gerade in der Playlist sind und nicht pasuiert ist -> pausieren
                if (data["position"] !== -1 && !data["paused"]) {
                    data["paused"] = true;
                    player.playPause();
                    messageArr.push("paused");
                    startCountdown();
                }
                break;

            //Pause-Status toggeln
            case 'toggle-paused-restart': case 'toggle-paused':
                playSound("pause.wav");

                //Wenn wir gerade in der Playlist sind
                if (data["position"] !== -1) {

                    //Pausenstatus toggeln, Player Pause toggeln und Info an clients
                    data["paused"] = !data["paused"];
                    player.playPause();
                    messageArr.push("paused");

                    //Wenn jetzt pausiert ist, Countdown starten
                    if (data["paused"]) {
                        startCountdown(2);
                    }

                    //Pausierung wurde beendet -> Countdown beenden
                    else {
                        resetCountdown();
                    }
                }

                //Playlist ist schon vorbei -> wieder von vorne beginnen, Playlist laden und starten
                else {
                    data["position"] = 0;
                    player.exec("loadlist " + __dirname + "/playlist.txt");

                    //Countdown abbrechen
                    resetCountdown();
                }
                break;

            //Lautstaerke aendern
            case 'change-volume':

                //Wenn es lauter werden soll, max. 100 setzen
                if (value) {
                    data["volume"] = Math.min(100, data["volume"] + 10);
                }

                //es soll leiser werden, min. 0 setzen
                else {
                    data["volume"] = Math.max(0, data["volume"] - 10);
                }

                //Lautstaerke setzen und Clients informieren
                setVolume();
                messageArr.push("volume");
                break;

            //Herz-Mix-Ordner anpassen (Dateien loeschen, umbenennen, neu hinkopieren)
            case "update-mix-folder":

                //Herz-Mix-Folder laueft gerade -> Playback stoppen
                if (data["playlist"] === data["mixDir"]) {
                    console.log("stop mix folder playback");
                    player.stop();
                }

                //Ueber einzelne Aktionen (add, rename, remove) gehen und ausfuehren
                for (const action of value) {
                    switch (action.type) {

                        //Neue Datei kommt aus Ordner ausserhalb
                        case "copy":
                            console.log("copy " + action.from + " to " + action.to);
                            await fs.copy(action.from, action.to);
                            break;

                        //Datei aus Herz-Mix-Ornder wird umbenannt fuer passende Reihenfolge
                        case "move":
                            console.log("move " + action.from + " to " + action.to);
                            await fs.move(action.from, action.to);
                            break;

                        //Datei aus Herz-Mix-Ordner wird geloescht
                        case "remove":
                            console.log("delete " + action.path);
                            await fs.remove(action.path);
                            break;
                    }
                }

                //Aktualisierten Inhalt des Herz-Mix-Folders ermitteln und an Clients melden
                await getMixFiles();

                //Herz-Mix-Folder lief gerade noch -> wieder starten mit neuen Dateien
                if (data["playlist"] === data["mixDir"]) {
                    console.log("start mix folder with new files");

                    //Info an Clients ueber neue Files
                    messageArr.push("paused", "files");

                    //Setlist erstellen und starten
                    await setPlaylist(false, false);
                }
                break;

            //userMode setzen fuer Herz-Mix-Files Dir
            case "set-user-mode":
                data["userMode"] = value;
                setMixDir();
                messageArr.push("userMode", "mixDir");
                getMixFiles();
                break;

            //System herunterfahren
            case "shutdown":
                shutdown();
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageArr);
    });

    //Clients beim einmalig bei der Verbindung ueber div. Wert informieren
    const WSConnectMessageArr = ["volume", "position", "paused", "files", "activeItem", "activeItemName", "countdownTime", "mixDir", "mixFiles", "searchFiles", "mainJSON", "userMode", "pageTitle"];
    WSConnectMessageArr.forEach(message => {
        ws.send(JSON.stringify({
            "type": message,
            "value": data[message]
        }));
    });
});

//Timer-Funktion benachrichtigt regelmaessig die WS ueber aktuelle Position des Titels
function startTimer() {

    //Wenn time_pos property geliefert wirde
    player.on('time_pos', (totalSecondsFloat) => {

        //Wie viele Sekunden ist der Track schon gelaufen? Float zu int: 13.4323 => 13
        data["secondsPlayed"] = Math.trunc(totalSecondsFloat);

        //Wie viele Sekunden laeuft der Track noch?
        //TODO: const
        const totalSecondsRaw = data["fileLength"] - data["secondsPlayed"];
        //console.log("track progress " + data["secondsPlayed"] + " - track time left " + totalSecondsRaw);

        //Umrechung der Sekunden in [h, m, s] fuer formattierte Darstellung
        const hours = Math.floor(totalSecondsRaw / 3600);
        const totalSeconds = totalSecondsRaw % 3600;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        //[2,44,1] => 02:44:01
        data["time"] = timelite.time.str([hours, minutes, seconds]);

        //Clients ueber aktuelle Zeit informieren
        sendClientInfo(["time"]);
    });

    //Jede Sekunde die aktuelle Zeit innerhalb des Titels liefern
    setInterval(() => {
        player.getProps(['time_pos']);
    }, 1000);
}

//Playlist erstellen und starten
async function setPlaylist(reloadSession, readPlaylist) {

    //Sicherstellen, dass Verzeichnis existiert, aus dem die Dateien geladen werden sollen
    if (fs.pathExists(data["playlist"])) {

        //Wenn Playlist vorgelesen werden soll (z.B. bei STT)
        if (readPlaylist) {

            //Player stoppen und Sprachausgabe fuer ausgewaehlte Playlist mit passender Sprache
            player.stop();

            //Split /home/pi/Nextcloud/audio/wap/mp3/hsp/bibi-tina/50-das-kuerbisfest, um Namen der Vorlesedatei abzuleiten -> hsp-bibi-tina-48-ein-ungebetener-gast.wav
            splitPath = (data["playlist"].split("/"));
            readFileName = splitPath[splitPath.length - 3] + "-" + splitPath[splitPath.length - 2] + "-" + splitPath[splitPath.length - 1] + ".wav";

            //Playlist vorlesen
            execSync(`aplay ${readFilesDir}/${readFileName}`);

            //TODO: dauert 4 Sek bis Skript weiterlaeuft
            /*
            await singleSoundPlayer.play({
                path: readFilesDir + "/" + readFileName,
                sync: true
            });
            */
        }

        //Ueber Dateien in aktuellem Verzeichnis gehen und mp3 sammeln
        const files = await fs.readdir(data["playlist"]);
        data["files"] = [];
        for (const file of files) {
            if ([".mp3"].includes(path.extname(file).toLowerCase())) {
                //console.log("add file " + file);
                data["files"].push(data["playlist"] + "/" + file);
            }
        }

        //Playlist-Datei schreiben (1 Zeile pro item)
        await fs.writeFile(__dirname + "/playlist.txt", data["files"].join("\n"));

        //Playlist-Datei laden und starten
        player.exec("loadlist " + __dirname + "/playlist.txt");

        //Wenn die Daten aus einer alten Session kommen, zu gewissem Titel springen, wenn nicht sowieso der erste Titel
        if (reloadSession) {
            if (data["position"] > 0) {
                player.exec("pt_step " + data["position"]);
            }
        }
    }

    //Verzeichnis existiert nicht
    else {
        console.log("dir doesn't exist " + data["playlist"]);
    }
}

//Infos der Session in File schreiben
function writeSessionJson() {
    fs.writeJSON(__dirname + "/lastSession.json", {
        path: data["playlist"],
        activeItem: data["activeItem"],
        activeItemName: data["activeItemName"],
        activeItemLang: data["activeItemLang"] || "de-DE",
        position: data["position"],
        readPlaylist: false
    });
}

//Infos ans WS-Clients schicken
//Dazu ueber Liste der Messages gehen, Message-Object erzeugen und an Liste der Clients verschicken
function sendClientInfo(messageArr) {
    messageArr.forEach(message => {
        const messageObj = {
            "type": message,
            "value": data[message]
        };
        for (const ws of wss.clients) {
            try {
                ws.send(JSON.stringify(messageObj));
            }
            catch (e) { }
        }
    });
}

//JSON fuer Oberflaeche berechnen mit aktiven Foldern, Filtern,...
function getMainJSON() {
    var start = new Date().getTime();
    console.log("get main json");

    //In Audiolist sind Infos ueber Modes und Filter
    const jsonDir = audioDir + "/wap/json";
    const jsonObj = fs.readJSONSync(jsonDir + "/audiolist.json");

    //Array, damit auslesen der einzelnen Unter-JSONs (bibi-tina.json, bobo.json) parallel erfolgen kann
    const modeDataFileArr = [];

    //Ueber Modes gehen (hsp, kindermusik, cds, extra)
    for (let [mode, modeData] of Object.entries(jsonObj)) {

        //merken, welche Filter geloescht werden sollen
        const inactiveFilters = [];

        //Ueber Filter des Modus gehen (bibi-tina, bobo,...)
        for (const [index, filterData] of modeData["filter"]["filters"].entries()) {

            //filterID merken (bibi-tina, bobo)
            const filterID = filterData["id"];

            //All-Filter wird immer angezeigt -> "active" loeschen (wird nicht fuer die Oberflaeche benoetigt)
            if (filterID === "all") {
                delete jsonObj[mode]["filter"]["filters"][index]["active"];
                continue;
            }

            //Wenn Modus aktiv ist
            if (filterData["active"]) {

                //Feld "active" loeschen (wird nicht fuer die Oberflaeche benoetigt)
                delete jsonObj[mode]["filter"]["filters"][index]["active"];

                //JSON dieses Filters holen (z.B. bibi-tina.json)
                const jsonLink = jsonDir + "/" + mode + "/" + filterID + ".json";
                modeData = {
                    data: fs.readJSONSync(jsonLink),
                    filterID: filterID,
                    mode: mode
                };
                modeDataFileArr.push(modeData);
            }

            //Filter (und die zugehoerigen Dateien) sollen nicht sichtbar sein -> Filter sammeln -> wird spaeter geloescht
            else {
                inactiveFilters.push(filterData);
            }
        }

        //Ueber inaktive Filter gehen und aus JSON-Obj loeschen
        inactiveFilters.forEach(filter => {
            const filterIndex = jsonObj[mode]["filter"]["filters"].indexOf(filter);
            jsonObj[mode]["filter"]["filters"].splice(filterIndex, 1);
        });
    }

    //Ueber die Treffer (JSON-files) gehen
    modeDataFileArr.forEach(result => {

        //Ueber Daten (z.B. einzelne Audio-Playlists) gehen
        result["data"].forEach(modeItem => {

            //Modus einfuegen (damit Filterung in Oberflaeche geht)
            modeItem["mode"] = result["filterID"];

            //Playlist-Objekt in Ausgabe Objekt einfuegen
            jsonObj[result["mode"]]["items"].push(modeItem);
        });
    });

    //Wert merken, damit er an Clients uebergeben werden kann
    console.log("get main json done");
    var end = new Date().getTime();
    var time = end - start;
    console.log('Execution time: ' + time);
    data["mainJSON"] = jsonObj;
}

//Aktuelle Dateien aus Herz-Mix-Ordner holen und an Clients schicken
async function getMixFiles() {
    console.log("get mix files");
    const files = await glob.promise(data["mixDir"] + "/*.mp3");
    data["mixFiles"] = files.map(path => {
        return {
            "type": "old",
            "path": path
        }
    });
    console.log("get mix files done");
    sendClientInfo(["mixFiles"]);
};

//Dateien fuer Herz-Mix-Suche ermitteln
async function getSearchFiles() {
    console.log("get search files");

    //cds, kindermusik und shp komplett anbieten
    const mp3Files = await glob.promise(audioDir + "/{wap/mp3/cds,wap/mp3/kindermusik,shp}/**/*.mp3");

    //Erstellungsdatum fuer Sortierung ermitteln
    const searchFiles = mp3Files.map(filePath => {
        return {
            "path": filePath,
            "name": path.basename(filePath, '.mp3'),
            "date": fs.statSync(filePath).birthtime
        }
    });

    //Dateien in Array nach Erstellungsdatum absteigend sortieren => neueste Dateien auf Server werden zuerst angeboten
    console.log("get search files done");
    data["searchFiles"] = _.sortBy(searchFiles, 'date').reverse();
    sendClientInfo(["searchFiles"]);
}

//Lautstaerke setzen
function setVolume() {
    if (configFile.audioOutput) {
        const volumeCommand = "amixer sset " + configFile.audioOutput + " " + data["volume"] + "% -M";
        console.log(volumeCommand);
        exec(volumeCommand);
    }
    else {
        console.log("no audioOutput configured");
    }
}

//Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
function startCountdown(factor = 1) {
    console.log("start countdown");
    data["countdownTime"] = countdownTime * factor;
    countdownID = setInterval(countdown, 1000);
}

//Countdown fuer Shutdown wieder stoppen, weil nun etwas passiert und Countdowntime zuruecksetzen und Clients informieren
function resetCountdown() {
    console.log("reset countdown");
    clearInterval(countdownID);
    countdownID = null;
    data["countdownTime"] = -1;
    sendClientInfo(["countdownTime"]);
}

//Bei Inaktivitaet Countdown runterzaehlen und Shutdown ausfuehren
function countdown() {

    //Wenn der Countdown noch nicht abgelaufen ist
    if (data["countdownTime"] >= 0) {
        //console.log("shutdown in " + data["countdownTime"] + " seconds");

        //Anzahl der Sekunden bis Countdown an Clients schicken
        sendClientInfo(["countdownTime"]);

        //Zeit runterzaehlen
        data["countdownTime"]--;
    }

    //Countdown ist abgelaufen, Shutdown durchfuehren
    else {
        shutdown();
    }
}

//Herz-Mix-Ordner setzen
function setMixDir() {
    data["mixDir"] = audioFilesDir + "/extra/misc/heart-mix-" + data["userMode"];
}

//Einzelsound abspielen
function playSound(sound) {
    const playedSound = sound || "button.wav";
    singleSoundPlayer.play({ path: __dirname + "/sounds/" + playedSound });
}

//Pi herunterfahren
function shutdown() {
    console.log("shutdown");

    //Shutdown-Info an Clients schicken
    sendClientInfo(["shutdown"]);

    //Pi herunterfahren
    exec("shutdown -h now");
}