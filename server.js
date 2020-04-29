//Mplayer + Wrapper anlegen
const createPlayer = require('mplayer-wrapper');
const player = createPlayer();
const { spawn } = require('child_process');

//Zeit Formattierung laden: [5, 13, 22] => 05:13:22
const timelite = require('timelite');

//Filesystem und Path Abfragen fuer Playlist und weitere Utils
const path = require('path');
const glob = require("glob");
const _ = require("underscore");
const fs = require('fs-extra');
var shuffle = require('shuffle-array');
const colors = require('colors');
const { execSync } = require('child_process');

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080, clientTracking: true });

//Aus Config auslesen wo die Audio-Dateien liegen
const configFile = fs.readJsonSync(__dirname + '/config.json');
const audioDir = configFile["audioDir"];
console.log("audio files are located in " + audioDir.yellow);

//Befehl fuer Autostart in Datei schreiben
fs.writeFile("/home/" + configFile["user"] + "/wss-install/last-player", "AUTOSTART=sudo /home/" + configFile["user"] + "/mh_prog/AudioServer/startnode.sh");

//Wo liegt der Joker-Ordner?
//TODO
const jokerFolder = audioDir + "/hsp/misc/joker";

//Wo liegen die Mix-Files
//TODO
const mixDir = audioDir + "/kindermusik/misc/mix"

//Zeit wie lange bis Shutdown durchgefuhert wird bei Inaktivitaet
const countdownTime = configFile.countdownTime;
var countdownID = null;

//GPIO Buttons starten, falls konfiguriert
if (configFile.GPIOButtons) {
    console.log("Use GPIO Buttons");
    const buttons_gpio = spawn("node", [__dirname + "/../WSGpioButtons/button.js"]);
    buttons_gpio.stdout.on("data", (data) => {
        console.log("button event: " + data);
    });
}

//USB RFID Reader starten, falls konfiguriert
if (configFile.USBRFIDReader) {
    console.log("Use USB RFID Reader");
    const rfid_usb = spawn("node", [__dirname + "/../WSRFID/rfid.js"]);
    rfid_usb.stdout.on('data', (data) => {
        console.log("rfid event: " + data);
    });
}

//Aktuelle Infos zu Volume / Position in Song / Position innerhalb der Playlist / Playlist / PausedStatus / Random merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
var data = [];
data["volume"] = configFile["volume"];
data["position"] = -1;
data["files"] = [];
data["paused"] = false;
data["random"] = false;
data["allowRandom"] = false;
data["activeItem"] = "";
data["activeItemName"] = "";
data["playlist"] = "";
data["fileLength"] = 0;
data["secondsPlayed"] = 0;
data["time"] = 0;
data["countdownTime"] = -1;
data["jokerLock"] = false;
data["mixFiles"] = [];
data["mainJSON"] = {};

//JSON fuer Oberflaeche erstellen mit Infos zu aktiven Foldern, Filtern, etc.
getMainJSON();

//Aktuellen Inhalt des MixFolders holen
getMixFiles();

//Auswaehlbar mp3 Dateien fuer MIX ermitteln, Dateien aus Joker und Mix-Ordner nicht anbieten
//TODO JOKER
const mp3Files = glob.sync(audioDir + "/../{wap,shp}/**/*.mp3", { "ignore": [mixDir + "/*.mp3", audioDir + "/hsp/misc/joker/*.mp3"] })
const searchFiles = mp3Files.map(filePath => {
    return {
        "path": filePath,
        "name": path.basename(filePath, '.mp3'),
        "date": fs.statSync(filePath).birthtime
    }
});

//Dateien in Array nach Erstellungsdatum absteigend sortieren => neueste Dateien auf Server werden zuerst angeboten
data["searchFiles"] = _.sortBy(searchFiles, 'date').reverse();

//initiale Lautstaerke setzen
setVolume();

//Wenn Playlist fertig ist
player.on('playlist-finish', () => {

    //Position zuruecksetzen
    data["position"] = -1;

    //Info in JSON schreiben, dass Playlist vorbei ist
    writeSessionJson();

    //Countdown starten
    if (!countdownID) {
        console.log("playlist finished");
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
if (fs.existsSync(__dirname + "/lastSession.json")) {
    try {
        const lastSessionObj = fs.readJsonSync(__dirname + "/lastSession.json");
        data["playlist"] = lastSessionObj.path;
        console.log("load playlist from last session " + data["playlist"]);

        //Letzte Infos laden
        data["activeItem"] = lastSessionObj.activeItem;
        data["activeItemName"] = lastSessionObj.activeItemName;
        data["allowRandom"] = lastSessionObj.allowRandom;
        data["position"] = lastSessionObj.position;

        //diese Playlist zu Beginn spielen
        setPlaylist(true);
    }
    catch (e) {
        console.log("invalid lastSeesion.json file");
    }
}

//TimeFunktion starten, die aktuelle Laufzeit des Titels liefert
startTimer();

//Wenn sich ein WebSocket mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Wenn WS eine Nachricht an WSS sendet
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        var obj = JSON.parse(message);
        let type = obj.type;
        let value = obj.value;

        //Array von Messages erstellen, die an Client gesendet werden
        let messageArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //neue Playlist laden (ueber Browser-Aufruf) oder per RFID
            case "set-playlist": case "set-rfid-playlist":
                console.log(type + JSON.stringify(value));

                //Audio-Verzeichnis, random und aktives Item merken
                data["playlist"] = audioDir + "/" + value.mode + "/" + value.path;
                data["allowRandom"] = value.allowRandom;
                data["activeItem"] = value.path;
                data["activeItemName"] = value.name;

                //Countdown abbrechen
                resetCountdown();

                //neue Playlist und allowRandom in Session-JSON-File schreiben
                writeSessionJson();

                //Setlist erstellen und starten
                setPlaylist(false);

                //Es ist nicht mehr pausiert
                data["paused"] = false;

                //Zusaetzliche Nachricht an clients
                messageArr.push("paused", "activeItem", "activeItemName", "files", "allowRandom");
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
                    }

                    //wir sind beim letzten Titel
                    else {
                        console.log("kein next beim letzten Track");

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
                            console.log("go to previous track")
                            player.previous();
                        }

                        //Titel ist schon mehr als x Sekunden gelaufen -> Titel nochmal von vorne starten
                        else {
                            console.log("repeat current track");
                            player.seekPercent(0);
                        }
                    }

                    //wir sind beim 1. Titel
                    else {
                        console.log("1. Titel von vorne");

                        //Playlist nochmal von vorne starten
                        player.seekPercent(0);

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
                let jumpTo = value - data["position"];
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

                //+/- 10 Sek
                let seekTo = value ? 10 : -10;

                //seek in item
                player.seek(seekTo);
                break;

            //Pause-Status toggeln
            case 'toggle-paused-restart': case 'toggle-paused':

                //Wenn wir gerade in der Playlist sind
                if (data["position"] !== -1) {

                    //Pausenstatus toggeln, Player Pause toggeln und Info an clients
                    data["paused"] = !data["paused"];
                    player.playPause();
                    messageArr.push("paused");

                    //Wenn jetzt pausiert ist, Countdown starten
                    if (data["paused"]) {
                        startCountdown();
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

            //Random toggle
            case 'toggle-random':

                //Random-Wert togglen
                data["random"] = !data["random"];

                //Wenn random erlaubt ist
                if (data["allowRandom"]) {

                    //Aktuelle Playlist mit neuem Random-Wert neu laden
                    setPlaylist();
                }

                //Pausierung zuruecksetzen und Clients informieren
                data["paused"] = false;

                //Nachricht an clients ueber aktuellen Random-Wert und file-list
                messageArr.push("random", "files", "paused");
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

            //Eine existierende Playlist in den Jokerordner kopieren (vorher Verzeichnis leeren)
            case "set-joker":
                if (data["jokerLock"]) {
                    console.log("joker is locked");
                    return;
                }

                //Lock setzen, damit nicht 2 Leute gleichzeitig den Joker Ordner setzen und direkt die Nutzer informieren
                data["jokerLock"] = true;
                sendClientInfo(["jokerLock"]);

                //Aus welchem Ordner kommt der Joker-Inhalt
                let wantedJokerFolder = audioDir + "/" + value;

                //Joker-Folder der mit neuen Datei bespielt werden soll, laueft gerade -> Playback stoppen
                if (data["playlist"] === jokerFolder) {
                    console.log("stop joker folder playback");
                    player.stop();
                }

                //Joker Verzeichnis leeren
                console.log("empty joker dir " + jokerFolder);
                fs.emptyDirSync(jokerFolder);

                //Neuen Dateien dorthin kopieren
                console.log("copy files from " + wantedJokerFolder + " to joker folder " + jokerFolder);
                fs.copySync(wantedJokerFolder, jokerFolder);

                //Lock wieder oeffnen nach Kopiervorgang und Benutzer informieren
                data["jokerLock"] = false;
                messageArr.push("jokerLock");

                //Joker-Folder lief gerade noch -> wieder starten mit neuen Dateien
                if (data["playlist"] === jokerFolder) {
                    console.log("start joker folder with new tracks");

                    //Info an Clients ueber neue Files
                    messageArr.push("paused", "files");

                    //Setlist erstellen und starten
                    setPlaylist(false);
                }
                break;

            //Mix-Ordner anpassen (Dateien loeschen, umbenennen, neu hinkopieren)
            case "update-mix-folder":

                //Mix-Folder laueft gerade -> Playback stoppen
                if (data["playlist"] === mixDir) {
                    console.log("stop mix folder playback");
                    player.stop();
                }

                //Ueber einzelne Aktionen (add, rename, remove) gehen und ausfuehren
                for (action of value) {
                    switch (action.type) {

                        //Neue Datei kommt aus Ordner ausserhalb
                        case "copy":
                            console.log("copy " + action.from + " to " + action.to);
                            fs.copySync(action.from, action.to);
                            break;

                        //Datei aus Mixordner wird umbenannt fuer passende Reihenfolge
                        case "move":
                            console.log("move " + action.from + " to " + action.to);
                            fs.moveSync(action.from, action.to);
                            break;

                        //Datei aus Mixordner wird geloescht
                        case "remove":
                            console.log("delete " + action.path);
                            fs.removeSync(action.path);
                            break;
                    }
                }

                //Aktualisierten Inhalt des Mix-Folders ermitteln und an Clients melden
                getMixFiles();
                messageArr.push("mixFiles");

                //Mix-Folder lief gerade noch -> wieder starten mit neuen Dateien
                if (data["playlist"] === mixDir) {
                    console.log("start mix folder with new tracks");

                    //Info an Clients ueber neue Files
                    messageArr.push("paused", "files");

                    //Setlist erstellen und starten
                    setPlaylist(false);
                }
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
    let WSConnectMessageArr = ["volume", "position", "paused", "files", "random", "activeItem", "activeItemName", "allowRandom", "countdownTime", "jokerLock", "mixFiles", "searchFiles", "mainJSON"];
    WSConnectMessageArr.forEach(message => {
        ws.send(JSON.stringify({
            "type": message,
            "value": data[message]
        }));
    });
});

//Timer-Funktion benachrichtigt regelmaessig die WS ueber aktuelle Position des Tracks
function startTimer() {

    //Wenn time_pos property geliefert wirde
    player.on('time_pos', (totalSecondsFloat) => {

        //Wie viele Sekunden ist der Track schon gelaufen? Float zu int: 13.4323 => 13
        data["secondsPlayed"] = Math.trunc(totalSecondsFloat);

        //Wie viele Sekunden laeuft der Track noch?
        let totalSeconds = data["fileLength"] - data["secondsPlayed"];
        console.log("track progress " + data["secondsPlayed"] + " - track time left " + totalSeconds);

        //Umrechung der Sekunden in [h, m, s] fuer formattierte Darstellung
        let hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        let minutes = Math.floor(totalSeconds / 60);
        let seconds = totalSeconds % 60;

        //h, m, s-Werte in Array packen
        let output = [hours, minutes, seconds];

        //[2,44,1] => 02:44:01
        data["time"] = timelite.time.str(output);

        //Clients ueber aktuelle Zeit informieren
        sendClientInfo(["time"]);
    });

    //Jede Sekunde die aktuelle Zeit innerhalb des Tracks liefern
    setInterval(() => {
        player.getProps(['time_pos']);
    }, 1000);
}

//Playlist erstellen und starten
function setPlaylist(reloadSession) {

    //Sicherstellen, dass Verzeichnis existiert, aus dem die Dateien geladen werden sollen
    if (fs.existsSync(data["playlist"])) {

        //Liste der files zuruecksetzen
        data["files"] = [];

        //Ueber Dateien in aktuellem Verzeichnis gehen
        fs.readdirSync(data["playlist"]).forEach(file => {

            //mp3 (audio) files sammeln
            if ([".mp3"].includes(path.extname(file).toLowerCase())) {
                console.log("add file " + file);
                data["files"].push(data["playlist"] + "/" + file);
            }
        });

        //Bei Random und erlaubtem Random, FileArray shuffeln
        if (data["random"] && data["allowRandom"]) {
            shuffle(data["files"]);
        }

        //Playlist-Datei schreiben (1 Zeile pro item)
        fs.writeFileSync(__dirname + "/playlist.txt", data["files"].join("\n"));

        //Playlist-Datei laden und starten
        player.exec("loadlist " + __dirname + "/playlist.txt");

        //Wenn die Daten aus einer alten Session kommen
        if (reloadSession) {

            //zu gewissem Titel springen, wenn nicht sowieso der erste Titel
            if (data["position"] > 0) {
                player.exec("pt_step " + data["position"]);
            }
        }
    }

    //Verzeichnis existiert nicht
    else {
        console.log("dir doesn't exist " + data["playlist"].red);
    }
}

//Infos der Session in File schreiben
function writeSessionJson() {
    fs.writeJsonSync(__dirname + "/lastSession.json", {
        path: data["playlist"],
        activeItem: data["activeItem"],
        activeItemName: data["activeItemName"],
        allowRandom: data["allowRandom"],
        position: data["position"]
    });
}

//Infos ans WS-Clients schicken
function sendClientInfo(messageArr) {

    //Ueber Liste der Messages gehen
    messageArr.forEach(message => {

        //Message-Object erzeugen
        let messageObj = {
            "type": message,
            "value": data[message]
        };

        //Ueber Liste der Clients gehen und Nachricht schicken
        for (ws of wss.clients) {
            try {
                ws.send(JSON.stringify(messageObj));
            }
            catch (e) { }
        }
    });
}

//JSON fuer Oberflaeche berechnen mit aktiven Foldern, Filtern,...
function getMainJSON() {

    //In Audiolist sind Infos ueber Modes und Filter
    const jsonObj = fs.readJSONSync(configFile["jsonDir"] + "/audioList.json");

    //Array, damit auslesen der einzelnen Unter-JSONs (bibi-tina.json, bobo.json) parallel erfolgen kann
    let modeDataFileArr = [];

    //Ueber Modes gehen (hsp, kindermusik, musikmh)
    for (let [mode, modeData] of Object.entries(jsonObj)) {

        //merken, welche Filter geloescht werden sollen
        let inactiveFilters = [];

        //Ueber Filter des Modus gehen (bibi-tina, bobo,...)
        modeData["filter"]["filters"].forEach((filterData, index) => {

            //filterID merken (bibi-tina, bobo)
            let filterID = filterData["id"];

            //All-Filter wird immer angezeigt -> "active" loeschen (wird nicht fuer die Oberflaeche benoetigt)
            if (filterID === "all") {
                delete jsonObj[mode]["filter"]["filters"][index]["active"];
                return;
            }

            //Wenn Modus aktiv ist
            if (filterData["active"]) {

                //Feld "active" loeschen (wird nicht fuer die Oberflaeche benoetigt)
                delete jsonObj[mode]["filter"]["filters"][index]["active"];

                //JSON dieses Filters holen (z.B. bibi-tina.json)
                const jsonLink = configFile["jsonDir"] + "/" + mode + "/" + filterID + ".json";
                modeData = {
                    data: fs.readJSONSync(jsonLink),
                    filterID: filterID,
                    mode: mode
                };

                //Titel merken eines Items
                modeDataFileArr.push(modeData);
            }

            //Filter (und die zugehoerigen Dateien) sollen nicht sichtbar sein -> Filter sammeln -> wird spaeter geloescht
            else {
                inactiveFilters.push(filterData);
            }
        });

        //Ueber inaktive Filter gehen und aus JSON-Obj loeschen
        inactiveFilters.forEach(filter => {
            let filterIndex = jsonObj[mode]["filter"]["filters"].indexOf(filter);
            jsonObj[mode]["filter"]["filters"].splice(filterIndex, 1);
        });

        //Ueber die Treffer (JSON-files) gehen
        modeDataFileArr.forEach(result => {

            //Ueber Daten (z.B. einzelne Audio-Playlists) gehen
            result["data"].forEach(modeItem => {

                //Wenn Playlist aktiv ist
                if (modeItem["active"]) {

                    //Feld "active" loeschen
                    delete modeItem["active"];

                    //Modus einfuegen (damit Filterung in Oberflaeche geht)
                    modeItem["mode"] = result["filterID"];

                    //Playlist-Objekt in Ausgabe Objekt einfuegen
                    jsonObj[result["mode"]]["items"].push(modeItem);
                }
            });
        });
    }

    //Wert merken, damit er an Clients uebergeben werden kann
    data["mainJSON"] = jsonObj;
}

//Aktuelle Dateien aus Mix-Ordner holen
function getMixFiles() {
    const mixFolderFiles = glob.sync(mixDir + "/*.mp3")
    data["mixFiles"] = mixFolderFiles.map(path => {
        return {
            "type": "old",
            "path": path
        }
    });
}

//Lautstaerke setzen
function setVolume() {
    if (configFile["audioOutput"]) {
        const initialVolumeCommand = "sudo amixer sset " + configFile["audioOutput"] + " " + + data["volume"] + "% -M";
        console.log(initialVolumeCommand);
        execSync(initialVolumeCommand);
    }
    else {
        console.log("no audioOutput configured");
    }
}

//Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
function startCountdown() {
    console.log("start countdown")
    data["countdownTime"] = countdownTime;
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
        console.log("shutdown in " + data["countdownTime"] + " seconds");

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

//Pi herunterfahren
function shutdown() {
    console.log("shutdown");

    //Shutdown-Info an Clients schicken
    sendClientInfo(["shutdown"]);

    //Pi herunterfahren
    execSync("shutdown -h now");
}