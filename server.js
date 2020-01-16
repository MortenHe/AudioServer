//Mplayer + Wrapper anlegen
const createPlayer = require('mplayer-wrapper');
const player = createPlayer();
const { spawn } = require('child_process');

//Zeit Formattierung laden: [5, 13, 22] => 05:13:22
const timelite = require('timelite');

//Filesystem und Path Abfragen fuer Playlist und weitere Utils
const path = require('path');
const fs = require('fs-extra');
var shuffle = require('shuffle-array');
const colors = require('colors');
const { execSync } = require('child_process');

//Befehl fuer Autostart in Datei schreiben
fs.writeFile("/home/pi/wss-install/last-player", "AUTOSTART=sudo /home/pi/mh_prog/AudioServer/startnode.sh");

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080, clientTracking: true });

//Aus Config auslesen wo die Audio-Dateien liegen
const configFile = fs.readJsonSync(__dirname + '/config.json');
const audioDir = configFile["audioDir"];
console.log("audio files are located in " + audioDir.yellow);

//Wo liegen die Joker Ordner?
const jokerDir = "hsp/misc";

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
data["time"] = 0;
data["countdownTime"] = -1;
data["jokerLock"] = false;

//initiale Lautstaerke setzen
setVolume();

//Wenn Playlist fertig ist
player.on('playlist-finish', () => {
    console.log("playlist finished");

    //Position zuruecksetzen
    data["position"] = -1;

    //Info in JSON schreiben, dass Playlist vorbei ist
    writeSessionJson();

    //Countdown starten
    if (!countdownID) {
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

                    //Wenn wir nicht beim 1. Titel sind, zum vorherigen Titel springen
                    if (data["position"] > 0) {
                        player.previous();
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

                //Ermitteln von wo nach wo die Dateien kopiert werden
                let jokerFolder = audioDir + "/" + jokerDir + "/joker-" + value.jokerMode;
                let wantedJokerFolder = audioDir + "/" + value.wantedJokerFolder;

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

            //System herunterfahren
            case "shutdown":
                shutdown();
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageArr);
    });

    //Clients einmalig bei der Verbindung ueber div. Wert informieren
    let WSConnectMessageArr = ["volume", "position", "paused", "files", "random", "activeItem", "activeItemName", "allowRandom", "countdownTime"];

    //Ueber Messages gehen, die an Clients geschickt werden
    WSConnectMessageArr.forEach(message => {

        //Message-Object erzeugen und an Client schicken
        let messageObj = {
            "type": message,
            "value": data[message]
        };
        ws.send(JSON.stringify(messageObj));
    });
});

//Timer-Funktion benachrichtigt regelmaessig die WS ueber aktuelle Position des Tracks
function startTimer() {

    //Wenn time_pos property geliefert wirde
    player.on('time_pos', (totalSecondsFloat) => {

        //Float zu int: 13.4323 => 13
        let totalSeconds = data["fileLength"] - Math.trunc(totalSecondsFloat);
        console.log('track progress is', totalSeconds);

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

//Lautstaerke setzen
function setVolume() {
    const initialVolumeCommand = "sudo amixer sset " + configFile["audioOutput"] + " " + + data["volume"] + "% -M";
    console.log(initialVolumeCommand)
    execSync(initialVolumeCommand);
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