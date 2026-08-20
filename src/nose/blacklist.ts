// 黑名单：确定性系统破坏操作模式（随版本内置；用户可手动编辑，责任自负）。
// 匹配对象为归一化文本（反斜杠已转正斜杠，空白折叠；terminal 不转小写，模式一律 /i）。
export const BLACKLIST_PATTERNS: readonly RegExp[] = [
  // rm -rf 跟 根（"/" 或 "/*"）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+\/(?:\s|$|\*)/i,
  // rm -rf 跟 盘符根（"c:/" 后即结尾/空白）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+[a-z]:\/(?:\s|$)/i,
  // rm -rf 跟 Windows 系统目录：windows[/system32|/boot] 或裸 windows 结尾；
  // 注意终结符——"c:/windows/temp" 不命中（temp 可恢复，走审批）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+[a-z]:\/windows(?:\/(?:system32|boot)(?:\s|$|\/)|\s|$)/i,
  // rm -rf 跟 System Volume Information（系统还原区）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+[a-z]:\/system\s+volume\s+information(?:\s|$|\/)/i,
  // rm -rf 跟 Unix 系统目录（/boot /etc /usr /bin /sbin /lib /lib64）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+\/(?:boot|etc|usr|bin|sbin|lib(?:64)?)(?:\s|$|\/)/i,
  // rd /s、rmdir /s 跟盘符（Windows 递归删除目录）
  /\b(?:rd|rmdir)\s+\/s\b[^\n|;]*[a-z]:\/[^\n|;]*/i,
  // del /f（可 /s）跟盘符
  /\bdel\s+\/f(?:\s+\/s)?\b[^\n|;]*[a-z]:\/[^\n|;]*/i,
  // 启动文件删除：bootmgr / boot.ini / boot 目录（磁盘根级）
  /\bdel\b[^\n|;]*(?:bootmgr|boot\.ini|\bboot\b)/i,
  // PowerShell Remove-Item 跟盘符 / HKLM 关键注册表（HKLM: 冒号可选——归一化只转反斜杠不删冒号）
  /\bRemove-Item\b[^\n|;]*(?:-[^\n|;]*[a-z]:\/|HKLM:?\/)/i,
  // 系统盘格式化
  /\b(?:format|Format-Volume)\b[^\n|;]*(?:[a-z]:|SystemDrive|DriveLetter)/i,
  // 整盘擦除
  /\bdiskpart\b[^\n|;]*clean/i,
  /\bClear-Disk\b/i,
  /\bcipher\s+\/w\b[^\n|;]*[a-z]:/i,
  // 块设备直写：dd of= 物理盘（归一化后 \\ 已是 /，物理盘为 //./ 前缀）
  /\bdd\b[^\n|;]*of=(?:\/\/\.\/|\/dev\/(?:sd[a-z]+\d*|nvme\d+n\d+))/i,
  // 块设备重定向：> /dev/sdX、/dev/nvme*（不含 /dev/null、/dev/shm）
  />\s*\/dev\/(?:sd[a-z]+\d*|nvme\d+n\d+)/i,
  // 文件系统重建 / 分区表 / 磁盘擦除
  /\b(?:mkfs(?:\.[a-z0-9]+)?|mke2fs)\b[^\n|;]*(?:\/dev\/|[a-z]:)/i,
  /\bparted\b[^\n|;]*mklabel/i,
  /\bdiskutil\b[^\n|;]*erase/i,
  /\bfdisk\b[^\n|;]*delete/i,
  /\bshred\b[^\n|;]*\s+(?:\/dev\/|[a-z]:)/i,
  // 启动配置删除 / Boot 关键注册表删除 / 杀之必崩进程
  /\bbcdedit\b[^\n|;]*\/delete/i,
  /\breg\s+delete\b[^\n|;]*(?:HKLM\/SYSTEM|Windows NT\/CurrentVersion)/i,
  /\btaskkill\b[^\n|;]*\/f[^\n|;]*(?:lsass|csrss|wininit|winlogon)/i,
  // 权限全毁（chmod -R 000 跟 / 或系统目录）
  /\bchmod\s+-R\s+000\s+\/(?:\s|$|(?:etc|usr|bin|sbin|lib(?:64)?)(?:\s|$|\/))/i,
  // 写类工具写系统目录（path 形态锚定开头——terminal 命令串不以盘符开头，天然只命中写类）
  /^[a-z]:\/windows\/(?:system32|boot)(?:\/|$)/i,
  /^[a-z]:\/system\s+volume\s+information(?:\/|$)/i,
];
