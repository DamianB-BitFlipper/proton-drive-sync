# Disable rpmbuild binary processing - Bun executables are self-contained
# and must not be modified by strip, build-id injection, etc.
%global __os_install_post %{nil}
%global __arch_install_post %{nil}

Name:           %{_name}
Version:        %{_version}
Release:        %{_release}
Summary:        Sync local directories to Proton Drive cloud storage
License:        GPL-3.0
URL:            https://github.com/DamianB-BitFlipper/proton-drive-sync
Requires:       libsecret
Conflicts:      proton-drive-sync, proton-drive-sync-prerelease
Provides:       proton-drive-sync-cli

%description
A CLI tool that syncs local directories to Proton Drive using
the official Proton Drive SDK.

%install
mkdir -p %{buildroot}/usr/bin
install -m 755 %{_sourcedir}/proton-drive-sync %{buildroot}/usr/bin/

%files
/usr/bin/proton-drive-sync

%preun
if [ $1 -eq 0 ]; then
    /usr/bin/proton-drive-sync service uninstall -y 2>/dev/null || true
    /usr/bin/proton-drive-sync auth --logout 2>/dev/null || true
fi
