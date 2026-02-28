const { log } = require('./logger');

class WindowService {
  async getActiveWindow() {
    try {
      if (process.platform === 'darwin') {
        return await this.getActiveWindowMac();
      } else if (process.platform === 'win32') {
        return await this.getActiveWindowWindows();
      }
      return null;
    } catch (err) {
      log('WINDOW', 'Failed to get active window:', err.message);
      return null;
    }
  }

  getActiveWindowMac() {
    // Try native addon first (fast ~5ms, works in MAS sandbox)
    try {
      const { getActiveWindow } = require('active-window-addon');
      const info = getActiveWindow();
      if (info) {
        info.platform = 'darwin';
        return Promise.resolve(info);
      }
    } catch (err) {
      log('WINDOW', 'Native addon unavailable:', err.message);
    }

    return Promise.resolve(null);
  }

  getActiveWindowWindows() {
    // Windows implementation uses PowerShell
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      const script = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class Win32 {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
            public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
          }
"@
        $hwnd = [Win32]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($hwnd, $sb, 256) | Out-Null
        $pid = 0
        [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        "$($proc.ProcessName)|$($sb.ToString())|$($hwnd.ToInt64())"
      `;

      exec(`powershell -Command "${script.replace(/"/g, '\\"')}"`, (err, stdout) => {
        if (err) return reject(err);

        const parts = stdout.trim().split('|');
        resolve({
          owner: parts[0] || '',
          title: parts[1] || '',
          hwnd: parts[2] || '',
          platform: 'win32',
        });
      });
    });
  }

  async focusWindow(windowInfo) {
    try {
      if (process.platform === 'darwin' && windowInfo?.owner) {
        return await this.focusWindowMac(windowInfo);
      } else if (process.platform === 'win32' && windowInfo?.hwnd) {
        return await this.focusWindowWindows(windowInfo);
      }
    } catch (err) {
      log('WINDOW', 'Failed to focus window:', err.message);
    }
  }

  focusWindowMac(windowInfo) {
    try {
      const { focusWindow } = require('active-window-addon');
      if (windowInfo.pid) {
        focusWindow(windowInfo.pid);
      }
      return Promise.resolve();
    } catch (err) {
      log('WINDOW', 'Native focusWindow failed:', err.message);
      return Promise.resolve();
    }
  }

  focusWindowWindows(windowInfo) {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      const script = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class Win32Focus {
            [DllImport("user32.dll")]
            public static extern bool SetForegroundWindow(IntPtr hWnd);
          }
"@
        [Win32Focus]::SetForegroundWindow([IntPtr]::new(${windowInfo.hwnd}))
      `;

      exec(`powershell -Command "${script.replace(/"/g, '\\"')}"`, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

let instance = null;

module.exports = {
  WindowService,
  getInstance: () => {
    if (!instance) instance = new WindowService();
    return instance;
  },
};
