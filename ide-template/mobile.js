(function () {
    var currentView = 'files';
    var programmaticResize = false;

    function triggerLayout() {
        programmaticResize = true;
        window.dispatchEvent(new Event('resize'));
        setTimeout(function () { programmaticResize = false; }, 500);
    }

    window.addEventListener('message', function (e) {
        if (!e.data || !e.data.ide) return;
        currentView = e.data.ide;
        document.body.classList.remove('ide-view-files', 'ide-view-claude');
        if (currentView !== 'editor') {
            document.body.classList.add('ide-view-' + currentView);
        }
        setTimeout(triggerLayout, 80);
        setTimeout(triggerLayout, 400);
    });

    document.addEventListener('click', function (e) {
        if (!document.body.classList.contains('ide-mobile')) return;
        var row = e.target.closest && e.target.closest('.monaco-list-row');
        if (row && row.getAttribute('aria-level')) {
            var isFolder = row.querySelector('.monaco-tl-twistie.collapsible');
            if (!isFolder) {
                setTimeout(function () {
                    window.parent.postMessage({ ideTabRequest: 'editor' }, '*');
                }, 150);
            }
        }
    }, true);

    function initMobile() {
        if (window.innerWidth <= 768) {
            document.body.classList.add('ide-mobile', 'ide-view-files');
            currentView = 'files';
        }
    }
    if (document.body) {
        initMobile();
    } else {
        document.addEventListener('DOMContentLoaded', initMobile);
    }

    window.addEventListener('resize', function () {
        if (programmaticResize) return;
        if (!document.body) return;
        if (window.innerWidth <= 768) {
            document.body.classList.add('ide-mobile');
            if (currentView !== 'editor' &&
                !document.body.classList.contains('ide-view-files') &&
                !document.body.classList.contains('ide-view-claude')) {
                document.body.classList.add('ide-view-' + currentView);
            }
        } else {
            document.body.classList.remove('ide-mobile', 'ide-view-files', 'ide-view-claude');
            currentView = 'files';
        }
    });
})();
