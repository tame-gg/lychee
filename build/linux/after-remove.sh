#!/bin/bash

removing_package() {
  case $1 in
    '' | 0 | remove | purge) return 0 ;;
  esac
  return 1
}

remove_netd() {
  local dir=$2
  if ! removing_package "$1"; then
    return 0
  fi
  rm -f "$dir/lychee-netd"
  rmdir "$dir" 2>/dev/null || true
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

remove_netd "$1" /usr/lib/lychee
