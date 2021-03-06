/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const TAB_STATE_NEEDS_RESTORE = 1;
const TAB_STATE_RESTORING = 2;

let state = {windows:[{tabs:[
  {entries:[{url:"http://example.com#1"}]},
  {entries:[{url:"http://example.com#2"}]},
  {entries:[{url:"http://example.com#3"}]},
  {entries:[{url:"http://example.com#4"}]},
  {entries:[{url:"http://example.com#5"}], hidden: true},
  {entries:[{url:"http://example.com#6"}], hidden: true},
  {entries:[{url:"http://example.com#7"}], hidden: true},
  {entries:[{url:"http://example.com#8"}], hidden: true}
]}]};

function test() {
  waitForExplicitFinish();

  registerCleanupFunction(function () {
    Services.prefs.clearUserPref("browser.sessionstore.restore_hidden_tabs");
  });

  // First stage: restoreHiddenTabs = true
  // Second stage: restoreHiddenTabs = false
  test_loadTabs(true, function () {
    test_loadTabs(false, finish);
  });
}

function test_loadTabs(restoreHiddenTabs, callback) {
  Services.prefs.setBoolPref("browser.sessionstore.restore_hidden_tabs", restoreHiddenTabs);

  let expectedTabs = restoreHiddenTabs ? 8 : 4;
  let firstProgress = true;

  newWindowWithState(state, function (win, needsRestore, isRestoring) {
    if (firstProgress) {
      firstProgress = false;
      is(isRestoring, 3, "restoring 3 tabs concurrently");
    } else {
      ok(isRestoring < 4, "restoring max. 3 tabs concurrently");
    }

    if (win.gBrowser.tabs.length - needsRestore == expectedTabs) {
      is(win.gBrowser.visibleTabs.length, 4, "only 4 visible tabs");

      TabsProgressListener.uninit();
      callback();
    }
  });
}

let TabsProgressListener = {
  init: function (win) {
    this.window = win;

    this.window.gBrowser.addTabsProgressListener(this);
  },

  uninit: function () {
    this.window.gBrowser.removeTabsProgressListener(this);

    delete this.window;
    delete this.callback;
  },

  setCallback: function (callback) {
    this.callback = callback;
  },

  onStateChange: function (aBrowser, aWebProgress, aRequest, aStateFlags, aStatus) {
    if (this.callback && aBrowser.__SS_restoreState == TAB_STATE_RESTORING &&
        aStateFlags & Ci.nsIWebProgressListener.STATE_STOP &&
        aStateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK &&
        aStateFlags & Ci.nsIWebProgressListener.STATE_IS_WINDOW)
      this.callback.apply(null, [this.window].concat(this.countTabs()));
  },

  countTabs: function () {
    let needsRestore = 0, isRestoring = 0;

    for (let i = 0; i < this.window.gBrowser.tabs.length; i++) {
      let browser = this.window.gBrowser.tabs[i].linkedBrowser;
      if (browser.__SS_restoreState == TAB_STATE_RESTORING)
        isRestoring++;
      else if (browser.__SS_restoreState == TAB_STATE_NEEDS_RESTORE)
        needsRestore++;
    }

    return [needsRestore, isRestoring];
  }
}

// ----------
function newWindowWithState(state, callback) {
  let opts = "chrome,all,dialog=no,height=800,width=800";
  let win = window.openDialog(getBrowserURL(), "_blank", opts);

  registerCleanupFunction(function () win.close());

  whenWindowLoaded(win, function onWindowLoaded(aWin) {
    TabsProgressListener.init(aWin);
    TabsProgressListener.setCallback(callback);

    ss.setWindowState(aWin, JSON.stringify(state), true);
  });
}
