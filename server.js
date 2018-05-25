//Mplayer + Wrapper anlegen
const createPlayer = require('mplayer-wrapper');
const player = createPlayer();

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080, clientTracking: true });

//Zeit Formattierung laden: [5, 13, 22] => 05:13:22
const timelite = require('timelite');

//Filesystem und Path Abfragen fuer Playlist
const path = require('path');
const fs = require('fs-extra');

//Array Shuffle Funktion
var shuffle = require('shuffle-array');

//Befehle auf Kommandzeile ausfuehren
const { execSync } = require('child_process');

//Wert fuer Pfad aus config.json auslesen
const configObj = fs.readJsonSync('./config.json');

//Verzeichnis, in dem die playlist.txt hinterlegt wird
const progDir = "/home/pi/mh_prog";

//Verzeichnis, in dem die Audiodateien liegen
const audioDir = "/media/audio";

//Aktuelle Infos zu Volume / Position in Song / Position innerhalb der Playlist / Playlist / PausedStatus / Random merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
currentVolume = 50;
currentPosition = -1;
currentFiles = [];
currentPaused = false;
currentRandom = false;
currentAllowRandom = false;
currentActiveItem = "";

//Lautstaerke zu Beginn setzen
let initialVolumeCommand = "sudo amixer sset PCM " + currentVolume + "% -M";
console.log(initialVolumeCommand)
execSync(initialVolumeCommand);

//Wenn bei Track change der Filename geliefert wird
player.on('filename', (filename) => {

    //Position in Playlist ermitteln
    currentPosition = currentFiles.indexOf(currentPlaylist + "/" + filename);

    //neue Position in Session-JSON-File schreiben
    writeSessionJson();

    //Position an Clients senden
    let messageObjArr = [{
        type: "set-position",
        value: currentPosition
    }];

    //Position-Infos an Clients schicken
    sendClientInfo(messageObjArr);
});

//Wenn Laenge des Tracks bei Track change geliefert wird
player.on('length', function (val) {
    console.log("Laenge ist " + val);
});

//Wenn sich ein Titel aendert (durch Nutzer oder durch den Player)
player.on('track-change', () => {

    //Neuen Dateinamen liefern
    player.getProps(['filename']);

    //Laenge des Titels liefern
    player.getProps(['length']);
});

//Wenn Playlist fertig ist
player.on('playlist-finish', () => {
    console.log("playlist finished");

    //Aktives Item zuruecksetzen
    currentActiveItem = "";

    //Clients informieren, dass Playlist fertig ist (position -1, activeItem "")
    let messageObjArr = [{
        type: "set-position",
        value: -1
    },
    {
        type: "active-item",
        value: currentActiveItem
    }];

    //Infos an Clients schicken
    sendClientInfo(messageObjArr);
});

//Infos aus letzter Session auslesen
try {

    //JSON-Objekt aus Datei holen
    const lastSessionObj = fs.readJsonSync('./lastSession.json');

    //Playlist-Pfad laden
    currentPlaylist = lastSessionObj.path;

    //Letztes aktives Item laden
    currentActiveItem = lastSessionObj.activeItem;

    //Laden, ob Randon erlaubt ist
    currentAllowRandom = lastSessionObj.allowRandom;

    //letzte Position in Playlist laden
    currentPosition = lastSessionObj.position;
}

//wenn lastSession.json noch nicht existiert
catch (e) {

    //keine Playlist laden
    currentPlaylist = "";
}

//Wenn eine Playlist aus der vorherigen Session geladen wurde
if (currentPlaylist) {
    console.log("Load playlist from last session " + currentPlaylist);

    //diese Playlist zu Beginn spielen
    setPlaylist(true);
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
        //console.log(obj)

        //Werte auslesen
        let type = obj.type;
        let value = obj.value;

        //Array von MessageObjekte erstellen, die an WS gesendet werden
        let messageObjArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //System herunterfahren
            case "shutdown":
                console.log("shutdown");

                //Shutdown-Info an Clients senden
                messageObjArr.push({
                    type: "shutdown",
                    value: ""
                });

                //Shutdown-Info an Clients schicken
                sendClientInfo(messageObjArr);

                //Pi herunterfahren
                execSync("shutdown -h now");
                break;

            //neue Playlist laden (ueber Browser-Aufruf) oder per RFID
            case "set-playlist": case "set-rfid-playlist":
                console.log(type + JSON.stringify(value));

                //Audio-Verzeichnis merken
                currentPlaylist = audioDir + "/" + value.mode + "/" + value.path;

                //Merken ob Random erlaubt ist
                currentAllowRandom = value.allowRandom;

                //aktives Item setzen
                currentActiveItem = value.path;

                //neue Playlist und allowRandom in Session-JSON-File schreiben
                writeSessionJson();

                //Setlist erstellen und starten
                setPlaylist(false);

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Zusaetzliche Nachricht an clients, dass nun nicht mehr pausiert ist, welches das active-item und file-list
                messageObjArr.push(
                    {
                        type: "toggle-paused",
                        value: currentPaused
                    },
                    {
                        type: "active-item",
                        value: currentActiveItem
                    },
                    {
                        type: "set-files",
                        value: currentFiles
                    },
                    {
                        type: "allow-random",
                        value: currentAllowRandom
                    });
                break;

            //Song wurde vom Nutzer weitergeschaltet
            case 'change-item':
                console.log("change-item " + value);

                //wenn der naechste Song kommen soll
                if (value) {

                    //Wenn wir noch nicht beim letzten Titel sind
                    if (currentPosition < (currentFiles.length - 1)) {

                        //zum naechsten Titel springen
                        player.next();
                    }

                    //wir sind beim letzten Titel
                    else {

                        //Wenn Titel pausiert war, wieder unpausen
                        if (currentPaused) {
                            player.playPause();
                        }
                        console.log("kein next beim letzten Track");
                    }
                }

                //der vorherige Titel soll kommen
                else {

                    //Wenn wir nicht beim 1. Titel sind
                    if (currentPosition > 0) {

                        //zum vorherigen Titel springen
                        player.previous();
                    }

                    //wir sind beim 1. Titel
                    else {

                        //Playlist nochmal von vorne starten
                        player.seekPercent(0);
                        console.log("1. Titel von vorne");

                        //Wenn Titel pausiert war, wieder unpausen
                        if (currentPaused) {
                            player.playPause();
                        }
                    }
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Nachricht an clients, dass nun nicht mehr pausiert ist
                messageObjArr.push({
                    type: "toggle-paused",
                    value: currentPaused
                });
                break;

            //Sprung zu einem bestimmten Titel in Playlist
            case "jump-to":

                //Wie viele Schritte in welche Richtung springen?
                let jumpTo = value - currentPosition;
                console.log("jump-to " + jumpTo);

                //wenn nicht auf den bereits laufenden geklickt wurde
                if (jumpTo !== 0) {

                    //zu gewissem Titel springen
                    player.exec("pt_step " + jumpTo);
                }

                //es wurde auf den bereits laufenden Titel geklickt
                else {

                    //diesen wieder von vorne abspielen
                    player.seekPercent(0);
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Nachricht an clients, dass nun nicht mehr pausiert ist
                messageObjArr.push({
                    type: "toggle-paused",
                    value: currentPaused
                });
                break;

            //Lautstaerke aendern
            case 'change-volume':

                //Wenn es lauter werden soll, max. 100 setzen
                if (value) {
                    currentVolume = Math.min(100, currentVolume + 10);
                }

                //es soll leiser werden, min. 0 setzen
                else {
                    currentVolume = Math.max(0, currentVolume - 10);
                }

                //Lautstaerke setzen
                let changeVolumeCommand = "sudo amixer sset PCM " + currentVolume + "% -M";
                console.log(changeVolumeCommand)
                execSync(changeVolumeCommand);

                //Nachricht mit Volume an clients schicken 
                messageObjArr.push({
                    type: type,
                    value: currentVolume
                });
                break;

            //Lautstaerke setzen
            case 'set-volume':

                //neue Lautstaerke merken 
                currentVolume = value;

                //Lautstaerke setzen
                let setVolumeCommand = "sudo amixer sset PCM " + value + "% -M";
                console.log(setVolumeCommand)
                execSync(setVolumeCommand);

                //Nachricht mit Volume an clients schicken 
                messageObjArr.push({
                    type: type,
                    value: currentVolume
                });
                break;

            //Pause-Status toggeln
            case 'toggle-paused':

                //Pausenstatus toggeln
                currentPaused = !currentPaused;

                //Pause toggeln
                player.playPause();

                //Nachricht an clients ueber Paused-Status
                messageObjArr.push({
                    type: "toggle-paused",
                    value: currentPaused
                });
                break;

            //Random toggle
            case 'toggle-random':

                //Random-Wert togglen
                currentRandom = !currentRandom;

                //Wenn random erlaubt ist
                if (currentAllowRandom) {

                    //Aktuelle Playlist mit neuem Random-Wert neu laden
                    setPlaylist();
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Nachricht an clients ueber aktuellen Random-Wert und file-list
                messageObjArr.push(
                    {
                        type: type,
                        value: currentRandom
                    },
                    {
                        type: "set-files",
                        value: currentFiles
                    }, {
                        type: "toggle-paused",
                        value: currentPaused
                    });
                break;

            //Innerhalb des Titels spulen
            case "seek":

                //+/- 10 Sek
                let seekTo = value ? 10 : -10;

                //seek in item
                player.seek(seekTo);
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageObjArr);
    });

    //WS einmalig bei der Verbindung ueber div. Wert informieren
    let WSConnectObjectArr = [{
        type: "set-volume",
        value: currentVolume
    }, {
        type: "set-position",
        value: currentPosition
    }, {
        type: "toggle-paused",
        value: currentPaused
    }, {
        type: "set-files",
        value: currentFiles
    }, {
        type: "toggle-random",
        value: currentRandom
    }, {
        type: "active-item",
        value: currentActiveItem
    }, {
        type: "allow-random",
        value: currentAllowRandom
    }];

    //Ueber Objekte gehen, die an WS geschickt werden
    WSConnectObjectArr.forEach(messageObj => {

        //Info an WS schicken
        ws.send(JSON.stringify(messageObj));
    });
});

//Timer-Funktion benachrichtigt regelmaessig die WS ueber aktuelle Position des Tracks
function startTimer() {
    console.log("startTimer");

    //Wenn time_pos property geliefert wirde
    player.on('time_pos', (totalSecondsFloat) => {

        //Float zu int: 13.4323 => 13
        let totalSeconds = Math.trunc(totalSecondsFloat);
        console.log('track progress is', totalSeconds);

        //Umrechung der Sekunden in [h, m, s] fuer formattierte Darstellung
        let hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        let minutes = Math.floor(totalSeconds / 60);
        let seconds = totalSeconds % 60;

        //h, m, s-Werte in Array packen
        let output = [hours, minutes, seconds];

        //[2,44,1] => 02:44:01
        let outputString = timelite.time.str(output);

        //Time-MessageObj erstellen
        let messageObjArr = [{
            type: "time",
            value: outputString
        }];

        //Clients ueber aktuelle Zeit informieren
        sendClientInfo(messageObjArr);
    });

    //Jede Sekunde die aktuelle Zeit innerhalb des Tracks liefern
    setInterval(() => {
        player.getProps(['time_pos']);
    }, 1000);
}

//Playlist erstellen und starten
function setPlaylist(reloadSession) {

    //Sicherstellen, dass Verzeichnis existiert, aus dem die Dateien geladen werden sollen
    if (fs.existsSync(currentPlaylist)) {

        //Liste der files zuruecksetzen
        currentFiles = [];

        //Ueber Dateien in aktuellem Verzeichnis gehen
        fs.readdirSync(currentPlaylist).forEach(file => {

            //mp3 (audio) files sammeln
            if ([".mp3"].includes(path.extname(file).toLowerCase())) {
                console.log("add file " + file);
                currentFiles.push(currentPlaylist + "/" + file);
            }
        });

        //Bei Random und erlaubtem Random
        if (currentRandom && currentAllowRandom) {

            //FileArray shuffeln
            shuffle(currentFiles);
        }

        //Playlist-Datei schreiben (1 Zeile pro item)
        fs.writeFileSync(progDir + "/playlist.txt", currentFiles.join("\n"));

        //Playlist-Datei laden und starten
        player.exec("loadlist " + progDir + "/playlist.txt");

        //Wenn die Daten aus einer alten Session kommen
        if (reloadSession) {

            //zu gewissem Titel springen, wenn nicht sowieso der erste Titel
            if (currentPosition > 0) {
                player.exec("pt_step " + currentPosition);
            }
        }
    }

    //Verzeichnis existiert nicht
    else {
        console.log("dir doesn't exist");
    }
}

//Infos der Session in File schreiben
function writeSessionJson() {

    //Position in Playlist zusammen mit anderen Merkmalen merken fuer den Neustart
    fs.writeJsonSync('./lastSession.json',
        {
            path: currentPlaylist,
            activeItem: currentActiveItem,
            allowRandom: currentAllowRandom,
            position: currentPosition
        });
}

//Infos ans WS-Clients schicken
function sendClientInfo(messageObjArr) {

    //Ueber Liste der MessageObjekte gehen
    messageObjArr.forEach(messageObj => {
        //console.log(messageObj)

        //Ueber Liste der WS gehen und Nachricht schicken
        for (ws of wss.clients) {
            try {
                ws.send(JSON.stringify(messageObj));
            }
            catch (e) { }
        }
    });
}