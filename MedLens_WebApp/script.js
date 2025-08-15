// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Animate elements on scroll
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.animationDelay = Math.random() * 0.3 + 's';
            entry.target.classList.add('animate-on-scroll');
        }
    });
}, observerOptions);

// Observe all cards and sections
document.querySelectorAll('.feature-card, .stat-card, .source-logo, .impact-card').forEach(el => {
    observer.observe(el);
});

// Add floating animation to hero elements
const hero = document.querySelector('.hero');
let ticking = false;

function updateHero() {
    const scrolled = window.pageYOffset;
    const parallax = scrolled * 0.5;
    
    hero.style.transform = `translateY(${parallax}px)`;
    ticking = false;
}

function requestHeroTick() {
    if (!ticking) {
        requestAnimationFrame(updateHero);
        ticking = true;
    }
}

window.addEventListener('scroll', requestHeroTick);

// Add click effects to CTA button
document.querySelector('.cta-button').addEventListener('click', function(e) {
    e.preventDefault();
    
    // Create ripple effect
    const ripple = document.createElement('span');
    const rect = this.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    
    ripple.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        left: ${x}px;
        top: ${y}px;
        background: rgba(255,255,255,0.3);
        border-radius: 50%;
        transform: scale(0);
        animation: ripple 0.6s ease-out;
        pointer-events: none;
    `;
    
    this.style.position = 'relative';
    this.style.overflow = 'hidden';
    this.appendChild(ripple);
    
    setTimeout(() => ripple.remove(), 600);
    
    // Show demo message
    setTimeout(() => {
        alert('Demo coming soon! MediLens will help you verify medical information instantly.');
    }, 300);
});

// Function to open MediLens app
function openMediLensApp() {
    // Navigate to verification page
    window.location.href = '#verify-page';
    
    // For demo purposes, we'll create and show the React component
    const appContainer = document.createElement('div');
    appContainer.id = 'medilens-app';
    appContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: white;
        z-index: 10000;
    `;
    
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '← Back to Home';
    closeBtn.style.cssText = `
        position: absolute;
        top: 20px;
        right: 20px;
        background: linear-gradient(45deg, #667eea, #764ba2);
        color: white;
        border: none;
        padding: 12px 24px;
        border-radius: 25px;
        font-weight: 600;
        cursor: pointer;
        z-index: 10001;
        transition: transform 0.3s;
    `;
    closeBtn.onmouseover = () => closeBtn.style.transform = 'translateY(-2px)';
    closeBtn.onmouseout = () => closeBtn.style.transform = 'translateY(0)';
    closeBtn.onclick = () => {
        document.body.removeChild(appContainer);
        window.location.href = '#home';
    };
    
    // Add message about React component
    const message = document.createElement('div');
    message.style.cssText = `
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        height: 100vh;
        padding: 40px;
        text-align: center;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
    `;
    
    message.innerHTML = `
        <div style="background: rgba(255,255,255,0.95); padding: 40px; border-radius: 20px; color: #333; max-width: 600px; box-shadow: 0 20px 40px rgba(0,0,0,0.1);">
            <div style="font-size: 3rem; margin-bottom: 20px;">🔍</div>
            <h1 style="font-size: 2rem; margin-bottom: 20px; color: #2c3e50;">MediLens Verification Tool</h1>
            <p style="font-size: 1.1rem; line-height: 1.6; margin-bottom: 30px; color: #666;">
                The React component has been created with full functionality including:
            </p>
            <ul style="text-align: left; margin: 20px 0; color: #555; list-style: none; padding: 0;">
                <li style="margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
                    📝 <strong>Text Input:</strong> Paste medical content for verification
                </li>
                <li style="margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
                    📁 <strong>File Upload:</strong> Drag & drop images, PDFs, documents
                </li>
                <li style="margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
                    🔍 <strong>AI Analysis:</strong> Real-time verification with loading states
                </li>
                <li style="margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
                    🎯 <strong>Color-coded Results:</strong> Green/Yellow/Red status indicators
                </li>
                <li style="margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
                    📊 <strong>Detailed Reports:</strong> Source attribution and explanations
                </li>
                <li style="margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
                    ✅ <strong>Alternative Info:</strong> Verified facts for false claims
                </li>
            </ul>
            <div style="background: #e3f2fd; padding: 20px; border-radius: 10px; margin-top: 20px; border-left: 4px solid #2196f3;">
                <strong>Component Features:</strong><br>
                • shadcn/ui components with Tailwind styling<br>
                • Lucide React icons throughout<br>
                • Responsive design for all devices<br>
                • Interactive drag & drop functionality<br>
                • Smart content analysis with demo results<br>
                • Professional medical verification interface
            </div>
        </div>
    `;
    
    appContainer.appendChild(message);
    appContainer.appendChild(closeBtn);
    document.body.appendChild(appContainer);
}

// Add CSS for ripple animation
const style = document.createElement('style');
style.textContent = `
    @keyframes ripple {
        to {
            transform: scale(2);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Add dynamic stats counter animation
function animateCounter(element, target) {
    let current = 0;
    const increment = target / 100;
    const timer = setInterval(() => {
        current += increment;
        if (current >= target) {
            current = target;
            clearInterval(timer);
        }
        
        if (element.textContent.includes('%')) {
            element.textContent = Math.floor(current) + '%';
        } else if (element.textContent.includes('×')) {
            element.textContent = Math.floor(current) + '×';
        } else if (element.textContent.includes('in')) {
            element.textContent = '1 in ' + Math.floor(current);
        }
    }, 20);
}

// Slideshow functionality
let currentSlide = 0;
const slides = document.querySelectorAll('.slide');
const indicators = document.querySelectorAll('.indicator');
const totalSlides = slides.length;

function showSlide(index) {
    // Hide all slides
    slides.forEach((slide, i) => {
        slide.classList.remove('active');
        if (i === currentSlide && i !== index) {
            slide.classList.add('slide-out');
            setTimeout(() => slide.classList.remove('slide-out'), 400);
        }
    });
    
    // Show current slide
    setTimeout(() => {
        slides[index].classList.add('active');
    }, 200);
    
    // Update indicators
    indicators.forEach((indicator, i) => {
        indicator.classList.toggle('active', i === index);
    });
    
    currentSlide = index;
}

function nextSlide() {
    const next = (currentSlide + 1) % totalSlides;
    showSlide(next);
}

// Auto slideshow
setInterval(nextSlide, 4000); // Change slide every 4 seconds

// Manual slide control
indicators.forEach((indicator, index) => {
    indicator.addEventListener('click', () => showSlide(index));
});

// Pause slideshow on hover
const slideshowContainer = document.querySelector('.slideshow-container');
let slideshowInterval;

function startSlideshow() {
    slideshowInterval = setInterval(nextSlide, 4000);
}

function stopSlideshow() {
    clearInterval(slideshowInterval);
}

slideshowContainer.addEventListener('mouseenter', stopSlideshow);
slideshowContainer.addEventListener('mouseleave', startSlideshow);

// Start the slideshow
startSlideshow();

// Trigger counter animations when stats section is visible
const statsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const numbers = entry.target.querySelectorAll('.stat-number');
            numbers.forEach(num => {
                if (num.textContent.includes('70')) animateCounter(num, 70);
                else if (num.textContent.includes('6')) animateCounter(num, 6);
                else if (num.textContent.includes('3')) animateCounter(num, 3);
            });
            statsObserver.unobserve(entry.target);
        }
    });
});

const statsSection = document.querySelector('.statistics');
if (statsSection) statsObserver.observe(statsSection);