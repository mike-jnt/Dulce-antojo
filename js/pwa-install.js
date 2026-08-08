/* Instalación PWA Dulce Antojo */
    (function(){
      const modal = document.getElementById("installPwaModal");
      const installButton = document.getElementById("installPwaButton");
      const laterButton = document.getElementById("installPwaLater");
      const iosHelp = document.getElementById("installPwaIosHelp");
      let deferredPrompt = null;

      const isStandalone = () =>
        window.matchMedia("(display-mode: standalone)").matches ||
        window.navigator.standalone === true;

      const isIOS = () =>
        /iphone|ipad|ipod/i.test(window.navigator.userAgent);

      const isSafari = () =>
        /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(window.navigator.userAgent);

      const wasDismissedRecently = () => {
        const dismissedAt = Number(localStorage.getItem("dulceAntojoInstallDismissedAt") || 0);
        if(!dismissedAt) return false;
        const days = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24);
        return days < 3;
      };

      const showInstallModal = (mode) => {
        if(!modal || isStandalone() || wasDismissedRecently()) return;
        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");

        if(mode === "ios"){
          iosHelp?.classList.add("show");
          installButton.textContent = "Ver instrucciones";
        }else if(mode === "manual"){
          iosHelp?.classList.remove("show");
          installButton.textContent = "Entendido";
        }else{
          iosHelp?.classList.remove("show");
          installButton.textContent = "Instalar aplicación";
        }
      };

      const closeInstallModal = () => {
        if(!modal) return;
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
      };

      window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        deferredPrompt = event;
        setTimeout(() => showInstallModal("native"), 900);
      });

      installButton?.addEventListener("click", async () => {
        if(deferredPrompt){
          deferredPrompt.prompt();
          const choice = await deferredPrompt.userChoice;
          deferredPrompt = null;
          closeInstallModal();
          if(choice && choice.outcome !== "accepted"){
            localStorage.setItem("dulceAntojoInstallDismissedAt", String(Date.now()));
          }
          return;
        }

        if(isIOS() && isSafari()){
          iosHelp?.classList.add("show");
          installButton.textContent = "Listo";
          return;
        }

        closeInstallModal();
      });

      laterButton?.addEventListener("click", () => {
        localStorage.setItem("dulceAntojoInstallDismissedAt", String(Date.now()));
        closeInstallModal();
      });

      modal?.addEventListener("click", (event) => {
        if(event.target === modal){
          localStorage.setItem("dulceAntojoInstallDismissedAt", String(Date.now()));
          closeInstallModal();
        }
      });

      window.addEventListener("appinstalled", () => {
        localStorage.setItem("dulceAntojoInstalled", "true");
        closeInstallModal();
      });

      window.addEventListener("load", () => {
        setTimeout(() => {
          if(isStandalone()) return;
          if(isIOS() && isSafari()){
            showInstallModal("ios");
          }
        }, 1400);
      });
    })();
