const hamburger = document.getElementById('hamburger-button');
const navMenu = document.getElementById('nav-menu');

// Add click handlers for all links with data-page attribute
function setupPageLinks() {
    const navMenu = document.getElementById('nav-menu'); // Ensure navMenu is defined
    document.querySelectorAll('a[data-page]').forEach(link => {
        link.addEventListener('click', function(event) {
            event.preventDefault();
            const page = event.target.getAttribute('data-page');
            window.location.hash = page; // Update URL hash

            // close the nav menu after a link is clicked
            if (navMenu) {
                navMenu.classList.remove('open');
                window.scrollTo(0, 0); // Scroll to the top of the page after using the hamburger icon

            }
        });
    });
}

function loadContent(page) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${page}.html`, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            if (xhr.status === 200) {
                document.getElementById('content').innerHTML = xhr.responseText;
                document.title = `VoteTorrent - ${page.charAt(0).toUpperCase() + page.slice(1)}`;
                setupPageLinks(); // Attach event listeners to newly loaded links
            } else if (xhr.status === 404) {
                document.getElementById('content').innerHTML = '<h1>Page Not Found</h1><p>The page you are looking for does not exist.</p>';
                document.title = 'VoteTorrent - 404';
            }
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

        const joinButton = document.querySelector('.cta-button.join');
    if (joinButton) {
        joinButton.addEventListener('click', () => {
            window.location.hash = 'join';
        });
    }

    const learnButton = document.querySelector('.cta-button.learn');
    if (learnButton) {
        learnButton.addEventListener('click', () => {
            window.location.hash = 'need';
        });
    }
    
    const hamburger = document.getElementById('hamburger-button');
    const navMenu = document.getElementById('nav-menu');
    

    const closeButton = document.getElementById('close-button');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            navMenu.classList.remove('open');
        });
    }

    hamburger.addEventListener('click', () => {
        hamburger.classList.toggle('open');
        navMenu.classList.toggle('open');
    });



    // Close menu when clicking a nav link
    document.querySelectorAll('a[data-page]').forEach(link => {
        link.addEventListener('click', function () {
            navMenu.classList.remove('open');
            hamburger.classList.remove('open');
        });
    });

});



