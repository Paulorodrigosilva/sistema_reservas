resourceSelect.addEventListener('change', () => {
  updateVehicleFields();
  fillSuggestedOdometer(); 
});
reservationForm.elements.inicio.addEventListener('change', fillSuggestedOdometer); // <- Remova ou comente esta linha
