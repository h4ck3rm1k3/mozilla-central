/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

let EXPORTED_SYMBOLS = ["WebappsInstaller"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");

let WebappsInstaller = {
  /**
   * Creates a native installation of the web app in the OS
   *
   * @param aData the manifest data provided by the web app
   *
   * @returns bool true on success, false if an error was thrown
   */
  install: function(aData) {

    try {
      if (Services.prefs.getBoolPref("browser.mozApps.installer.dry_run")) {
        return true;
      }
    } catch (ex) {}

#ifdef XP_WIN
    let shell = new WinNativeApp(aData);
#elifdef XP_MACOSX
    let shell = new MacNativeApp(aData);
#elifdef XP_UNIX
    let shell = new LinuxNativeApp(aData);
#else
    return false;
#endif

    try {
      shell.install();
    } catch (ex) {
      Cu.reportError("Error installing app: " + ex);
      return false;
    }

    return true;
  }
}

/**
 * This function implements the common constructor for
 * the Windows, Mac and Linux native app shells. It reads and parses
 * the data from the app manifest and stores it in the NativeApp
 * object. It's meant to be called as NativeApp.call(this, aData)
 * from the platform-specific constructor.
 *
 * @param aData the data object provided by the web app with
 *              all the app settings and specifications.
 *
 */
function NativeApp(aData) {
  let app = this.app = aData.app;

  let origin = Services.io.newURI(app.origin, null, null);

  if (app.manifest.launch_path) {
    this.launchURI = Services.io.newURI(origin.resolve(app.manifest.launch_path),
                                        null, null);
  } else {
    this.launchURI = origin.clone();
  }

  let biggestIcon = getBiggestIconURL(app.manifest.icons);
  try {
    let iconURI = Services.io.newURI(biggestIcon, null, null);
    if (iconURI.scheme == "data") {
      this.iconURI = iconURI;
    }
  } catch (ex) {}

  if (!this.iconURI) {
    try {
      this.iconURI = Services.io.newURI(origin.resolve(biggestIcon), null, null);
    }
    catch (ex) {}
  }

  this.appName = sanitize(app.manifest.name);
  this.appNameAsFilename = stripStringForFilename(this.appName);

  if(app.manifest.developer && app.manifest.developer.name) {
    let devName = app.manifest.developer.name.substr(0, 128);
    devName = sanitize(devName);
    if (devName) {
      this.developerName = devName;
    }
  }

  let shortDesc = this.appName;
  if (app.manifest.description) {
    let firstLine = app.manifest.description.split("\n")[0];
    shortDesc = firstLine.length <= 256
                ? firstLine
                : firstLine.substr(0, 253) + "...";
  }
  this.shortDescription = sanitize(shortDesc);

  this.manifest = app.manifest;

  this.profileFolder = Services.dirsvc.get("ProfD", Ci.nsIFile);
}

#ifdef XP_WIN
/*************************************
 * Windows app installer
 *
 * The Windows installation process will generate the following files:
 *
 * ${FolderName} = app-origin;protocol;port
 *                 e.g.: subdomain.example.com;http;-1
 *
 * %APPDATA%/${FolderName}
 *   - webapp.ini
 *   - webapp.json
 *   - ${AppName}.exe
 *   - ${AppName}.lnk
 *   / uninstall
 *     - webapp-uninstaller.exe
 *     - shortcuts_log.ini
 *     - uninstall.log
 *   / chrome/icons/default/
 *     - default.ico
 *
 * After the app runs for the first time, a profiles/ folder will also be
 * created which will host the user profile for this app.
 */

/**
 * Constructor for the Windows native app shell
 *
 * @param aData the data object provided by the web app with
 *              all the app settings and specifications.
 */
function WinNativeApp(aData) {
  NativeApp.call(this, aData);
  this._init();
}

WinNativeApp.prototype = {
  /**
   * Install the app in the system by creating the folder structure,
   *
   */
  install: function() {
    // Remove previously installed app (for update purposes)
    this._removeInstallation();

    try {
      this._createDirectoryStructure();
      this._copyPrebuiltFiles();
      this._createConfigFiles();
      this._createShortcutFiles();
      this._writeSystemKeys();
    } catch (ex) {
      this._removeInstallation();
      throw(ex);
    }

    getIconForApp(this, function() {});
  },

  /**
   * Initializes properties that will be used during the installation process,
   * such as paths and filenames.
   */
  _init: function() {
    let filenameRE = new RegExp("[<>:\"/\\\\|\\?\\*]", "gi");

    this.appNameAsFilename = this.appNameAsFilename.replace(filenameRE, "");
    if (this.appNameAsFilename == "") {
      this.appNameAsFilename = "webapp";
    }

    // The ${InstallDir} format is as follows:
    //  host of the app origin + ";" +
    //  protocol + ";" +
    //  port (-1 for default port)
    this.installDir = Services.dirsvc.get("AppData", Ci.nsIFile);
    this.installDir.append(this.launchURI.host + ";" + 
                           this.launchURI.scheme + ";" +
                           this.launchURI.port);

    this.uninstallDir = this.installDir.clone();
    this.uninstallDir.append("uninstall");

    this.uninstallerFile = this.uninstallDir.clone();
    this.uninstallerFile.append("webapp-uninstaller.exe");

    this.iconFile = this.installDir.clone();
    this.iconFile.append("chrome");
    this.iconFile.append("icons");
    this.iconFile.append("default");
    this.iconFile.append("default.ico");

    this.processFolder = Services.dirsvc.get("CurProcD", Ci.nsIFile);

    this.desktopShortcut = Services.dirsvc.get("Desk", Ci.nsILocalFile);
    this.desktopShortcut.append(this.appNameAsFilename + ".lnk");
    this.desktopShortcut.followLinks = false;

    this.startMenuShortcut = Services.dirsvc.get("Progs", Ci.nsILocalFile);
    this.startMenuShortcut.append(this.appNameAsFilename + ".lnk");
    this.startMenuShortcut.followLinks = false;

    this.uninstallSubkeyStr = this.launchURI.scheme + "://" +
                              this.launchURI.host + ":" +
                              this.launchURI.port;
  },

  /**
   * Remove the current installation
   */
  _removeInstallation : function() {
    let uninstallKey;
    try {
      uninstallKey = Cc["@mozilla.org/windows-registry-key;1"]
                     .createInstance(Ci.nsIWindowsRegKey);
      uninstallKey.open(uninstallKey.ROOT_KEY_CURRENT_USER,
                        "SOFTWARE\\Microsoft\\Windows\\" +
                        "CurrentVersion\\Uninstall",
                        uninstallKey.ACCESS_WRITE);
      if(uninstallKey.hasChild(this.uninstallSubkeyStr)) {
        uninstallKey.removeChild(this.uninstallSubkeyStr);
      }
    } catch (e) {
    } finally {
      if(uninstallKey)
        uninstallKey.close();
    }

    try {
      if(this.installDir.exists()) {
        let dir = this.installDir.QueryInterface(Ci.nsILocalFile);
        // We need to set followLinks to false so that the shortcut
        // files can be removed even after the .exe it was pointing
        // to was removed.
        dir.followLinks = false;
        dir.remove(true);
      }
    } catch(ex) {
    }

    try {
      if(this.desktopShortcut && this.desktopShortcut.exists()) {
        this.desktopShortcut.remove(false);
      }

      if(this.startMenuShortcut && this.startMenuShortcut.exists()) {
        this.startMenuShortcut.remove(false);
      }
    } catch(ex) {
    }
  },

  /**
   * Creates the main directory structure.
   */
  _createDirectoryStructure: function() {
    this.installDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    this.uninstallDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
  },

  /**
   * Copy the pre-built files into their destination folders.
   */
  _copyPrebuiltFiles: function() {
    let webapprt = this.processFolder.clone();
    webapprt.append("webapprt-stub.exe");
    webapprt.copyTo(this.installDir, this.appNameAsFilename + ".exe");

    let uninstaller = this.processFolder.clone();
    uninstaller.append("webapp-uninstaller.exe");
    uninstaller.copyTo(this.uninstallDir, this.uninstallerFile.leafName);
  },

  /**
   * Creates the configuration files into their destination folders.
   */
  _createConfigFiles: function() {
    // ${InstallDir}/webapp.json
    let json = {
      "registryDir": this.profileFolder.path,
      "app": this.app
    };

    let configJson = this.installDir.clone();
    configJson.append("webapp.json");
    writeToFile(configJson, JSON.stringify(json), function() {});

    // ${InstallDir}/webapp.ini
    let webappINI = this.installDir.clone().QueryInterface(Ci.nsILocalFile);
    webappINI.append("webapp.ini");

    let factory = Cc["@mozilla.org/xpcom/ini-processor-factory;1"]
                    .getService(Ci.nsIINIParserFactory);

    let writer = factory.createINIParser(webappINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("Webapp", "Name", this.appName);
    writer.setString("Webapp", "Profile", this.installDir.leafName);
    writer.setString("Webapp", "Executable", this.appNameAsFilename);
    writer.setString("WebappRT", "InstallDir", this.processFolder.path);
    writer.writeFile();

    // ${UninstallDir}/shortcuts_log.ini
    let shortcutLogsINI = this.uninstallDir.clone().QueryInterface(Ci.nsILocalFile);
    shortcutLogsINI.append("shortcuts_log.ini");

    writer = factory.createINIParser(shortcutLogsINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("STARTMENU", "Shortcut0", this.appNameAsFilename + ".lnk");
    writer.setString("DESKTOP", "Shortcut0", this.appNameAsFilename + ".lnk");
    writer.setString("TASKBAR", "Migrated", "true");
    writer.writeFile();

    writer = null;
    factory = null;

    // ${UninstallDir}/uninstall.log
    let uninstallContent = 
      "File: \\webapp.ini\r\n" +
      "File: \\webapp.json\r\n" +
      "File: \\webapprt.old\r\n" +
      "File: \\chrome\\icons\\default\\default.ico";
    let uninstallLog = this.uninstallDir.clone();
    uninstallLog.append("uninstall.log");
    writeToFile(uninstallLog, uninstallContent, function() {});
  },

  /**
   * Writes the keys to the system registry that are necessary for the app operation
   * and uninstall process.
   */
  _writeSystemKeys: function() {
    let parentKey;
    let uninstallKey;
    let subKey;

    try {
      parentKey = Cc["@mozilla.org/windows-registry-key;1"]
                  .createInstance(Ci.nsIWindowsRegKey);
      parentKey.open(parentKey.ROOT_KEY_CURRENT_USER,
                     "SOFTWARE\\Microsoft\\Windows\\CurrentVersion",
                     parentKey.ACCESS_WRITE);
      uninstallKey = parentKey.createChild("Uninstall", parentKey.ACCESS_WRITE)
      subKey = uninstallKey.createChild(this.uninstallSubkeyStr, uninstallKey.ACCESS_WRITE);

      subKey.writeStringValue("DisplayName", this.appName);

      subKey.writeStringValue("UninstallString", this.uninstallerFile.path);
      subKey.writeStringValue("InstallLocation", this.installDir.path);
      subKey.writeStringValue("AppFilename", this.appNameAsFilename);

      if(this.iconFile) {
        subKey.writeStringValue("DisplayIcon", this.iconFile.path);
      }

      subKey.writeIntValue("NoModify", 1);
      subKey.writeIntValue("NoRepair", 1);
    } catch(ex) {
      throw(ex);
    } finally {
      if(subKey) subKey.close();
      if(uninstallKey) uninstallKey.close();
      if(parentKey) parentKey.close();
    }
  },

  /**
   * Creates a shortcut file inside the app installation folder and makes
   * two copies of it: one into the desktop and one into the start menu.
   */
  _createShortcutFiles: function() {
    let shortcut = this.installDir.clone().QueryInterface(Ci.nsILocalFileWin);
    shortcut.append(this.appNameAsFilename + ".lnk");

    let target = this.installDir.clone();
    target.append(this.appNameAsFilename + ".exe");

    /* function nsILocalFileWin.setShortcut(targetFile, workingDir, args,
                                            description, iconFile, iconIndex) */

    shortcut.setShortcut(target, this.installDir.clone(), null,
                         this.shortDescription, this.iconFile, 0);

    let desktop = Services.dirsvc.get("Desk", Ci.nsILocalFile);
    let startMenu = Services.dirsvc.get("Progs", Ci.nsILocalFile);

    shortcut.copyTo(desktop, this.appNameAsFilename + ".lnk");
    shortcut.copyTo(startMenu, this.appNameAsFilename + ".lnk");

    shortcut.followLinks = false;
    shortcut.remove(false);
  },

  /**
   * This variable specifies if the icon retrieval process should
   * use a temporary file in the system or a binary stream. This
   * is accessed by a common function in WebappsIconHelpers.js and
   * is different for each platform.
   */
  useTmpForIcon: false,

  /**
   * Process the icon from the imageStream as retrieved from
   * the URL by getIconForApp(). This will save the icon to the
   * topwindow.ico file.
   *
   * @param aMimeType     ahe icon mimetype
   * @param aImageStream  the stream for the image data
   * @param aCallback     a callback function to be called
   *                      after the process finishes
   */
  processIcon: function(aMimeType, aImageStream, aCallback) {
    let iconStream;
    try {
      let imgTools = Cc["@mozilla.org/image/tools;1"]
                       .createInstance(Ci.imgITools);
      let imgContainer = { value: null };

      imgTools.decodeImageData(aImageStream, aMimeType, imgContainer);
      iconStream = imgTools.encodeImage(imgContainer.value,
                                        "image/vnd.microsoft.icon",
                                        "format=bmp;bpp=32");
    } catch (e) {
      throw("processIcon - Failure converting icon (" + e + ")");
    }

    this.iconFile.parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    let outputStream = FileUtils.openSafeFileOutputStream(this.iconFile);
    NetUtil.asyncCopy(iconStream, outputStream);
  }
}

#elifdef XP_MACOSX

function MacNativeApp(aData) {
  NativeApp.call(this, aData);
  this._init();
}

MacNativeApp.prototype = {
  _init: function() {
    this.appSupportDir = Services.dirsvc.get("ULibDir", Ci.nsILocalFile);
    this.appSupportDir.append("Application Support");

    let filenameRE = new RegExp("[<>:\"/\\\\|\\?\\*]", "gi");
    this.appNameAsFilename = this.appNameAsFilename.replace(filenameRE, "");
    if (this.appNameAsFilename == "") {
      this.appNameAsFilename = "Webapp";
    }

    // The ${ProfileDir} format is as follows:
    //  host of the app origin + ";" +
    //  protocol + ";" +
    //  port (-1 for default port)
    this.appProfileDir = this.appSupportDir.clone();
    this.appProfileDir.append(this.launchURI.host + ";" +
                              this.launchURI.scheme + ";" +
                              this.launchURI.port);

    this.installDir = Services.dirsvc.get("TmpD", Ci.nsILocalFile);
    this.installDir.append(this.appNameAsFilename + ".app");
    this.installDir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0755);

    this.contentsDir = this.installDir.clone();
    this.contentsDir.append("Contents");

    this.macOSDir = this.contentsDir.clone();
    this.macOSDir.append("MacOS");

    this.resourcesDir = this.contentsDir.clone();
    this.resourcesDir.append("Resources");

    this.iconFile = this.resourcesDir.clone();
    this.iconFile.append("appicon.icns");

    this.processFolder = Services.dirsvc.get("CurProcD", Ci.nsIFile);
  },

  install: function() {
    this._removeInstallation(true);
    try {
      this._createDirectoryStructure();
      this._copyPrebuiltFiles();
      this._createConfigFiles();
    } catch (ex) {
      this._removeInstallation(false);
      throw(ex);
    }

    getIconForApp(this, this._moveToApplicationsFolder);
  },

  _removeInstallation: function(keepProfile) {
    try {
      if(this.installDir.exists()) {
        this.installDir.followLinks = false;
        this.installDir.remove(true);
      }
    } catch(ex) {
    }

   if (keepProfile)
     return;

   try {
      if(this.appProfileDir.exists()) {
        this.appProfileDir.followLinks = false;
        this.appProfileDir.remove(true);
      }
    } catch(ex) {
    }
  },

  _createDirectoryStructure: function() {
    if (!this.appProfileDir.exists())
      this.appProfileDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);

    this.contentsDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    this.macOSDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    this.resourcesDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
  },

  _copyPrebuiltFiles: function() {
    let webapprt = this.processFolder.clone();
    webapprt.append("webapprt-stub");
    webapprt.copyTo(this.macOSDir, "webapprt");
  },

  _createConfigFiles: function() {
    // ${ProfileDir}/webapp.json
    let json = {
      "registryDir": this.profileFolder.path,
      "app": {
        "origin": this.launchURI.prePath,
        "installOrigin": "apps.mozillalabs.com",
        "manifest": this.manifest
       }
    };

    let configJson = this.appProfileDir.clone();
    configJson.append("webapp.json");
    writeToFile(configJson, JSON.stringify(json), function() {});

    // ${InstallDir}/Contents/MacOS/webapp.ini
    let applicationINI = this.macOSDir.clone().QueryInterface(Ci.nsILocalFile);
    applicationINI.append("webapp.ini");

    let factory = Cc["@mozilla.org/xpcom/ini-processor-factory;1"]
                    .getService(Ci.nsIINIParserFactory);

    let writer = factory.createINIParser(applicationINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("Webapp", "Name", this.appName);
    writer.setString("Webapp", "Profile", this.appProfileDir.leafName);
    writer.writeFile();

    // ${InstallDir}/Contents/Info.plist
    let infoPListContent = '<?xml version="1.0" encoding="UTF-8"?>\n\
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n\
<plist version="1.0">\n\
  <dict>\n\
    <key>CFBundleDevelopmentRegion</key>\n\
    <string>English</string>\n\
    <key>CFBundleDisplayName</key>\n\
    <string>' + escapeXML(this.appName) + '</string>\n\
    <key>CFBundleExecutable</key>\n\
    <string>webapprt</string>\n\
    <key>CFBundleIconFile</key>\n\
    <string>appicon</string>\n\
    <key>CFBundleIdentifier</key>\n\
    <string>' + escapeXML(this.launchURI.prePath) + '</string>\n\
    <key>CFBundleInfoDictionaryVersion</key>\n\
    <string>6.0</string>\n\
    <key>CFBundleName</key>\n\
    <string>' + escapeXML(this.appName) + '</string>\n\
    <key>CFBundlePackageType</key>\n\
    <string>APPL</string>\n\
    <key>CFBundleSignature</key>\n\
    <string>MOZB</string>\n\
    <key>CFBundleVersion</key>\n\
    <string>0</string>\n\
#ifdef DEBUG
    <key>FirefoxBinary</key>\n\
    <string>org.mozilla.NightlyDebug</string>\n\
#endif
  </dict>\n\
</plist>';

    let infoPListFile = this.contentsDir.clone();
    infoPListFile.append("Info.plist");
    writeToFile(infoPListFile, infoPListContent, function() {});
  },

  _moveToApplicationsFolder: function() {
    let appDir = Services.dirsvc.get("LocApp", Ci.nsILocalFile);
    let destination = getAvailableFile(appDir,
                                       this.appNameAsFilename,
                                       ".app");
    if (!destination) {
      return false;
    }
    this.installDir.moveTo(destination.parent, destination.leafName);
  },

  /**
   * This variable specifies if the icon retrieval process should
   * use a temporary file in the system or a binary stream. This
   * is accessed by a common function in WebappsIconHelpers.js and
   * is different for each platform.
   */
  useTmpForIcon: true,

  /**
   * Process the icon from the imageStream as retrieved from
   * the URL by getIconForApp(). This will bundle the icon to the
   * app package at Contents/Resources/appicon.icns.
   *
   * @param aMimeType     the icon mimetype
   * @param aImageStream  the stream for the image data
   * @param aCallback     a callback function to be called
   *                      after the process finishes
   */
  processIcon: function(aMimeType, aIcon, aCallback) {
    try {
      let process = Cc["@mozilla.org/process/util;1"]
                    .createInstance(Ci.nsIProcess);
      let sipsFile = Cc["@mozilla.org/file/local;1"]
                    .createInstance(Ci.nsILocalFile);
      sipsFile.initWithPath("/usr/bin/sips");

      process.init(sipsFile);
      process.run(true, ["-s",
                  "format", "icns",
                  aIcon.path,
                  "--out", this.iconFile.path,
                  "-z", "128", "128"],
                  9);
    } catch(e) {
      throw(e);
    } finally {
      aCallback.call(this);
    }
  }

}

#elifdef XP_UNIX

function LinuxNativeApp(aData) {
  NativeApp.call(this, aData);
  this._init();
}

LinuxNativeApp.prototype = {
  _init: function() {
    let filenameRE = new RegExp("[<>:\"/\\\\|\\?\\*]", "gi");

    this.appNameAsFilename = this.appNameAsFilename.replace(filenameRE, "");
    this.appNameAsFilename = this.appNameAsFilename.toLowerCase();

    // Need a unique name here, maybe like installDir on Windows
    this.installDir = Services.dirsvc.get("Home", Ci.nsILocalFile);
    this.installDir.append("." + this.appNameAsFilename);

    this.iconFile = this.installDir.clone();
    this.iconFile.append(this.appNameAsFilename + ".png");

    this.processFolder = Services.dirsvc.get("CurProcD", Ci.nsIFile);
  },

  install: function() {
    this._removeInstallation();
    try {
      this._createDirectoryStructure();
      this._copyPrebuiltFiles();
      this._createConfigFiles();
    } catch (ex) {
      this._removeInstallation();
      throw(ex);
    }

    getIconForApp(this);
  },

  _removeInstallation: function() {
    try {
      if (this.installDir.exists()) {
        this.installDir.followLinks = false;
        this.installDir.remove(true);
      }
    } catch(ex) {
    }
  },

  _createDirectoryStructure: function() {
    this.installDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0777);
  },

  _copyPrebuiltFiles: function() {
    let webapprt = this.processFolder.clone();
    webapprt.append("webapprt-stub");
    webapprt.copyTo(this.installDir, "webapprt-stub");
  },

  _createConfigFiles: function() {
    // ${InstallDir}/webapp.json
    let json = {
      "registryDir": this.profileFolder.path,
      "app": this.app
    };

    let configJson = this.installDir.clone();
    configJson.append("webapp.json");
    writeToFile(configJson, JSON.stringify(json), function() {});

    // ${InstallDir}/webapp.ini
    let webappINI = this.installDir.clone().QueryInterface(Ci.nsILocalFile);
    webappINI.append("webapp.ini");

    let factory = Cc["@mozilla.org/xpcom/ini-processor-factory;1"]
                    .getService(Ci.nsIINIParserFactory);

    let writer = factory.createINIParser(webappINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("Webapp", "Name", this.appName);
    writer.setString("Webapp", "Profile", this.appNameAsFilename);
    writer.setString("WebappRT", "InstallDir", this.processFolder.path);
    writer.writeFile();

    //NEEDS BUG 744190
    //let desktopINI = Services.dirsvc.get("XDGDataHome", Ci.nsIFile).QueryInterface(Ci.nsILocalFile);
    //desktopINI.append("applications");
    let desktopINI = this.installDir.clone();
    desktopINI.append(this.appNameAsFilename + ".desktop");

    let webapprtExecutable = this.installDir.clone();
    webapprtExecutable.append("webapprt-stub");

    writer = factory.createINIParser(desktopINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("Desktop Entry", "Name", this.appName);
    writer.setString("Desktop Entry", "Exec", webapprtExecutable.path);
    writer.setString("Desktop Entry", "Icon", this.iconFile.path);
    writer.setString("Desktop Entry", "Terminal", "false");
    writer.setString("Desktop Entry", "Type", "Application");
    writer.writeFile();

    // This code is to refresh menus under KDE
    try {
      // Are we sure kbuildsycoca is always in /usr/bin?
      let kbuildsycoca = new FileUtils.File("/usr/bin/kbuildsycoca");
      if (kbuildsycoca.exists()) {
        let process = Components.classes["@mozilla.org/process/util;1"]
                                .createInstance(Components.interfaces.nsIProcess);
        process.init(kbuildsycoca);
        process.runAsync([], 0);
      }
    }
    catch (e) {
      throw("Error executing kbuildsycoca: " + e);
    }
  },

  /**
   * This variable specifies if the icon retrieval process should
   * use a temporary file in the system or a binary stream. This
   * is accessed by a common function in WebappsIconHelpers.js and
   * is different for each platform.
   */
  useTmpForIcon: false,

  /**
   * Process the icon from the imageStream as retrieved from
   * the URL by getIconForApp().
   *
   * @param aMimeType     ahe icon mimetype
   * @param aImageStream  the stream for the image data
   * @param aCallback     a callback function to be called
   *                      after the process finishes
   */
  processIcon: function(aMimeType, aImageStream, aCallback) {
    let iconStream;
    try {
      let imgTools = Cc["@mozilla.org/image/tools;1"]
                       .createInstance(Ci.imgITools);
      let imgContainer = { value: null };

      imgTools.decodeImageData(aImageStream, aMimeType, imgContainer);
      // Check if we can put icons with different resolutions in the .desktop file
      iconStream = imgTools.encodeScaledImage(imgContainer.value,
                                              "image/png", 48, 48);
    } catch (e) {
      throw("processIcon - Failure converting icon (" + e + ")");
    }

    this.iconFile.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0777);
    let outputStream = FileUtils.openSafeFileOutputStream(this.iconFile);
    NetUtil.asyncCopy(iconStream, outputStream);
  }
}

#endif

/* Helper Functions */

/**
 * Async write a data string into a file
 *
 * @param aFile     the nsIFile to write to
 * @param aData     a string with the data to be written
 * @param aCallback a callback to be called after the process is finished
 */
function writeToFile(aFile, aData, aCallback) {
  let ostream = FileUtils.openSafeFileOutputStream(aFile);
  let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                    .createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";
  let istream = converter.convertToInputStream(aData);
  NetUtil.asyncCopy(istream, ostream, function(x) { aCallback(x); } );
}

/**
 * Removes unprintable characters from a string.
 */
function sanitize(aStr) {
  let unprintableRE = new RegExp("[\\x00-\\x1F\\x7F]" ,"gi");
  return aStr.replace(unprintableRE, "");
}

/**
 * Strips all non-word characters from the beginning and end of a string
 */
function stripStringForFilename(aPossiblyBadFilenameString) {
  //strip everything from the front up to the first [0-9a-zA-Z]

  let stripFrontRE = new RegExp("^\\W*","gi");
  let stripBackRE = new RegExp("\\s*$","gi");

  let stripped = aPossiblyBadFilenameString.replace(stripFrontRE, "");
  stripped = stripped.replace(stripBackRE, "");
  return stripped;
}

/**
 * Finds a unique name available in a folder (i.e., non-existent file)
 *
 * @param aFolder nsIFile that represents the directory where we want to write
 * @param aName   string with the filename (minus the extension) desired
 * @param aExtension string with the file extension, including the dot

 * @return nsILocalFile or null if folder is unwritable or unique name
 *         was not available
 */
function getAvailableFile(aFolder, aName, aExtension) {
  let folder = aFolder.QueryInterface(Ci.nsILocalFile);
  folder.followLinks = false;
  if (!folder.isDirectory() || !folder.isWritable()) {
    return null;
  }

  let file = folder.clone();
  file.append(aName + aExtension);

  if (!file.exists()) {
    return file;
  }

  for (let i = 2; i < 10; i++) {
    file.leafName = aName + " (" + i + ")" + aExtension;
    if (!file.exists()) {
      return file;
    }
  }

  for (let i = 10; i < 100; i++) {
    file.leafName = aName + "-" + i + aExtension;
    if (!file.exists()) {
      return file;
    }
  }

  return null;
}

function escapeXML(aStr) {
  return aStr.toString()
             .replace(/&/g, "&amp;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&apos;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;");
}

/* More helpers for handling the app icon */
#include WebappsIconHelpers.js
