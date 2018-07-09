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

//Farbiges Logging
const colors = require('colors');

//Befehle auf Kommandzeile ausfuehren
const { execSync } = require('child_process');

//Verzeichnis, in dem die Audiodateien liegen (linxus vs. windows)
const runMode = process.argv[2] ? process.argv[2] : "linux";
const audioDir = runMode === "win" ? "C:/mplayer-audio" : "/media/audio";
console.log("audio files are located in " + audioDir.yellow);

//System-Lautstaerke zu Beginn auf 100% setzen
//let initialVolumeCommand = "sudo amixer sset PCM 100% -M";
//console.log(initialVolumeCommand)
//execSync(initialVolumeCommand);

//System-Lautstaerke zu Beginn auf 100% setzen
const vol = require('vol');
vol.set(.02).then(() => {
    console.log('set system volume to 100%'.green);
});

//Aktuelle Infos zu Volume / Position in Song / Position innerhalb der Playlist / Playlist / PausedStatus / Random merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
currentVolume = 50;
currentPosition = -1;
currentFiles = [];
currentPaused = false;
currentRandom = false;
currentAllowRandom = false;
currentActiveItem = "";
currentPlaylist = "";

//Player zu Beginn auf 50% stellen
player.setVolume(currentVolume);

//Wenn Playlist fertig ist
player.on('playlist-finish', () => {
    console.log("playlist finished");

    //Position zuruecksetzen
    currentPosition = -1;

    //Info in JSON schreiben, dass Playlist vorbei ist
    writeSessionJson();

    //Clients informieren, dass Playlist fertig ist (position -1)
    sendClientInfo([{
        type: "set-position",
        value: currentPosition
    }]);
});

//Wenn bei Track change der Filename geliefert wird
player.on('filename', (filename) => {

    //Position in Playlist ermitteln
    currentPosition = currentFiles.indexOf(currentPlaylist + "/" + filename);

    //neue Position in Session-JSON-File schreiben
    writeSessionJson();

    //Position-Infos an Clients schicken
    sendClientInfo([{
        type: "set-position",
        value: currentPosition
    }]);
});

//Wenn sich ein Titel aendert (durch Nutzer oder durch den Player)
player.on('track-change', () => {

    //ggf. weg?
    player.setVolume(currentVolume);

    //Neuen Dateinamen liefern
    player.getProps(['filename']);
});

//Infos aus letzter Session auslesen, falls die Datei existiert
if (fs.existsSync('./lastSession.json')) {

    //JSON-Objekt aus Datei holen
    const lastSessionObj = fs.readJsonSync('./lastSession.json');

    //Playlist-Pfad laden
    currentPlaylist = lastSessionObj.path;
    console.log("load playlist from last session " + currentPlaylist);

    //Letztes aktives Item laden
    currentActiveItem = lastSessionObj.activeItem;

    //Laden, ob Randon erlaubt ist
    currentAllowRandom = lastSessionObj.allowRandom;

    //letzte Position in Playlist laden
    currentPosition = lastSessionObj.position;

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
                        console.log("kein next beim letzten Track");

                        //Wenn Titel pausiert war, wieder unpausen
                        if (currentPaused) {
                            player.playPause();
                        }
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
                        console.log("1. Titel von vorne");

                        //Playlist nochmal von vorne starten
                        player.seekPercent(0);

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

                //Wenn Playlist schon fertig ist
                if (currentPosition === -1) {

                    //wieder von vorne beginnen
                    currentPosition = 0;

                    //Playlist-Datei laden und starten
                    player.exec("loadlist playlist.txt");
                }

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

            //Innerhalb des Titels spulen
            case "seek":

                //+/- 10 Sek
                let seekTo = value ? 10 : -10;

                //seek in item
                player.seek(seekTo);
                break;

            //Pause-Status toggeln
            case 'toggle-paused-restart':

                //Wenn wir gerade in der Playlist sind
                if (currentPosition !== -1) {

                    //Pausenstatus toggeln
                    currentPaused = !currentPaused;

                    //Pause toggeln
                    player.playPause();

                    //Nachricht an clients ueber Paused-Status
                    messageObjArr.push({
                        type: "toggle-paused",
                        value: currentPaused
                    });
                }

                //Playlist ist schon vorbei
                else {

                    //wieder von vorne beginnen
                    currentPosition = 0;

                    //Playlist-Datei laden und starten
                    player.exec("loadlist playlist.txt");
                }
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
                console.log("change volume to " + currentVolume);
                player.setVolume(currentVolume);

                //Nachricht mit Volume an clients schicken 
                messageObjArr.push({
                    type: type,
                    value: currentVolume
                });
                break;

            //System herunterfahren
            case "shutdown":
                console.log("shutdown");

                //Shutdown-Info an Clients schicken
                sendClientInfo([{
                    type: "shutdown",
                    value: ""
                }]);

                //Pi herunterfahren
                execSync("shutdown -h now");
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageObjArr);
    });

    //WS einmalig bei der Verbindung ueber div. Wert informieren
    let WSConnectObjectArr = [{
        type: "change-volume",
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

        //Clients ueber aktuelle Zeit informieren
        sendClientInfo([{
            type: "time",
            value: outputString
        }]);
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
        fs.writeFileSync("playlist.txt", currentFiles.join("\n"));

        //Playlist-Datei laden und starten
        player.exec("loadlist playlist.txt");

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
        console.log("dir doesn't exist " + currentPlaylist.red);
    }
}

//Infos der Session in File schreiben
function writeSessionJson() {

    //Playlist zusammen mit anderen Merkmalen merken fuer den Neustart
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