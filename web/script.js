// Add click handlers for all links with data-page attribute
function setupPageLinks() {
    document.querySelectorAll('a[data-page]').forEach(link => {
        link.addEventListener('click', function(event) {
            event.preventDefault();
            const page = event.target.getAttribute('data-page');
            window.location.hash = page; // Update URL hash
        });
    });
}

function loadContent(page) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${page}.html`, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && xhr.status === 200) {
            document.getElementById('content').innerHTML = xhr.responseText;
            document.title = `VoteTorrent - ${page.charAt(0).toUpperCase() + page.slice(1)}`;
            setupPageLinks(); // Attach event listeners to newly loaded links
        }
    };
    xhr.send();
}

// Handle URL hash changes
function handleHashChange() {
    const page = window.location.hash.slice(1) || 'home';
    loadContent(page);
}

document.addEventListener("DOMContentLoaded", function() {
    // Set up hash change listener
    window.addEventListener('hashchange', handleHashChange);
    
    // Load content based on initial hash or default to home
    handleHashChange();
    
    // Setup initial page links
    setupPageLinks();
});
