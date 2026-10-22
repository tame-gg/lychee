#!/bin/bash

NETD_GROUP='lychee'

netd_group_id() {
  local gid
  gid=$(getent group "$NETD_GROUP" | cut -d: -f3)
  if [ -z "$gid" ]; then
    groupadd --system "$NETD_GROUP" || return 0
    gid=$(getent group "$NETD_GROUP" | cut -d: -f3)
  fi
  printf '%s\n' "$gid"
}

installing_user() {
  local uid name
  for uid in "$SUDO_UID" "$PKEXEC_UID"; do
    case $uid in
      '' | *[!0-9]* | 0) continue ;;
    esac
    name=$(getent passwd "$uid" | cut -d: -f1)
    if [ -n "$name" ]; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  return 0
}

in_netd_group() {
  getent group "$NETD_GROUP" | cut -d: -f4 | tr ',' '\n' | grep -qxF -- "$1"
}

grant_netd_group() {
  local user
  user=$(installing_user)
  if [ -z "$user" ]; then
    echo "Lychee: to combine connections without a password prompt, add yourself to the $NETD_GROUP group: sudo gpasswd -a \$USER $NETD_GROUP"
    return 0
  fi
  if in_netd_group "$user"; then
    return 0
  fi
  if gpasswd -a "$user" "$NETD_GROUP" >/dev/null; then
    echo "Lychee: added $user to the $NETD_GROUP group, which combines connections without a password prompt from the next login on"
  else
    echo "Lychee: could not add $user to the $NETD_GROUP group; run: sudo gpasswd -a $user $NETD_GROUP"
  fi
}

install_netd() {
  local source=$1 dir=$2 target=$2/lychee-netd gid
  PATH="$PATH:/usr/sbin:/sbin"
  if [ ! -f "$source" ]; then
    return 0
  fi
  gid=$(netd_group_id)
  if [ -z "$gid" ]; then
    echo "Lychee: could not create the $NETD_GROUP group; combining connections will ask for an administrator password instead"
    rm -f "$target"
    return 0
  fi
  mkdir -p "$dir"
  chown 0:0 "$dir"
  chmod 0755 "$dir"
  install -o 0 -g "$gid" -m 0750 "$source" "$target.tmp"
  mv -f "$target.tmp" "$target"
  if hash setcap 2>/dev/null; then
    setcap cap_net_admin,cap_net_raw+ep "$target" || echo "Lychee: setcap failed; combining connections will ask for an administrator password instead"
  else
    echo "Lychee: setcap is not installed; combining connections will ask for an administrator password instead"
  fi
  grant_netd_group
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

install_netd '/opt/${sanitizedProductName}/resources/helper/lychee-netd' /usr/lib/lychee
